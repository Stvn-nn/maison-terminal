"""Finnhub macro feed: economic calendar, market news and sentiment.

Tier notes (Finnhub, late 2026):

* ``/calendar/economic`` requires a paid plan. A free key gets a clean
  ``402 finnhub_premium_required`` error rather than a crash.
* ``/news`` and ``/company-news`` are available on the free plan.
* ``/news-sentiment`` may require a paid plan; when refused, symbol sentiment falls back to
  a local headline lexicon (``source: "lexicon"``).

The API key is sent in the ``X-Finnhub-Token`` header (never in URLs) and is never logged.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import time
from collections import deque
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any, TypeVar

import httpx
from fastapi import APIRouter, Depends, Query, Request

from config import Settings, finnhub_key
from errors import ApiError
from schemas import (
    EconomicCalendarResponse,
    EconomicEvent,
    HeadlineSentiment,
    ImpactLevel,
    MacroEventUpcomingData,
    NewsFlashData,
    NewsItem,
    NewsResponse,
    SentimentLabel,
    SymbolSentimentResponse,
    WsEventType,
)
from ws import WebSocketBroadcaster

logger = logging.getLogger("maison.news")

REQUEST_TIMEOUT_SECONDS = 10.0
MAX_CALENDAR_RANGE_DAYS = 31
DEFAULT_CALENDAR_RANGE_DAYS = 7
COMPANY_NEWS_LOOKBACK_DAYS = 7
MAX_NEWS_ITEMS = 100
MAX_NEWS_FLASHES_PER_POLL = 5
NEWS_CATEGORIES = ("general", "forex", "crypto", "merger")
SYMBOL_PATTERN = re.compile(r"^[A-Za-z0-9.:\-^=]{1,20}$")
IMPACT_RANK = {ImpactLevel.LOW: 1, ImpactLevel.MEDIUM: 2, ImpactLevel.HIGH: 3}
SENTIMENT_LABEL_THRESHOLD = 0.2

ResultType = TypeVar("ResultType")


# --------------------------------------------------------------------------------------
# Headline sentiment lexicon (finance-flavoured, intentionally small and transparent)
# --------------------------------------------------------------------------------------

BULLISH_TERMS = frozenset(
    """beat beats beating surge surges surged soar soars soared rally rallies rallied gain
    gains gained jump jumps jumped rise rises rising rose record upgrade upgraded upgrades
    outperform bullish strong stronger growth expand expands expansion profit profitable
    boost boosts boosted rebound rebounds recovery recover optimism optimistic exceed
    exceeds exceeded raise raises raised hike buyback dovish easing approval approved win
    wins breakthrough higher""".split()
)
BEARISH_TERMS = frozenset(
    """miss misses missed plunge plunges plunged slump slumps slumped fall falls fell drop
    drops dropped decline declines declined sink sinks sank tumble tumbles tumbled crash
    crashes downgrade downgraded downgrades underperform bearish weak weaker loss losses
    cut cuts cutting layoffs layoff recession inflation default bankruptcy lawsuit probe
    fraud warning warns warned fear fears concern concerns hawkish tightening selloff
    sell-off slowdown contraction shortfall lower risk risks""".split()
)
WORD_PATTERN = re.compile(r"[a-z][a-z\-]+")


def score_headline(text: str) -> HeadlineSentiment:
    """Score text in [-1, 1] by counting bullish vs bearish finance terms."""
    words = WORD_PATTERN.findall(text.lower())
    bullish_hits = sum(word in BULLISH_TERMS for word in words)
    bearish_hits = sum(word in BEARISH_TERMS for word in words)
    total_hits = bullish_hits + bearish_hits
    # +1 in the denominator damps single-word verdicts towards neutral.
    score = 0.0 if total_hits == 0 else (bullish_hits - bearish_hits) / (total_hits + 1)
    return HeadlineSentiment(score=round(score, 3), label=_label_for_score(score))


def _label_for_score(score: float) -> SentimentLabel:
    if score >= SENTIMENT_LABEL_THRESHOLD:
        return SentimentLabel.BULLISH
    if score <= -SENTIMENT_LABEL_THRESHOLD:
        return SentimentLabel.BEARISH
    return SentimentLabel.NEUTRAL


# --------------------------------------------------------------------------------------
# Infrastructure: rate limiter and TTL cache
# --------------------------------------------------------------------------------------


class SlidingWindowRateLimiter:
    """Allow at most ``max_calls`` per ``window_seconds``; callers wait for a free slot."""

    def __init__(
        self,
        max_calls: int,
        window_seconds: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._max_calls = max(1, max_calls)
        self._window_seconds = window_seconds
        self._clock = clock
        self._call_times: deque[float] = deque()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            while True:
                now = self._clock()
                while self._call_times and now - self._call_times[0] >= self._window_seconds:
                    self._call_times.popleft()
                if len(self._call_times) < self._max_calls:
                    self._call_times.append(now)
                    return
                await asyncio.sleep(self._window_seconds - (now - self._call_times[0]))


class TtlCache:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._entries: dict[str, tuple[float, Any]] = {}
        self._key_locks: dict[str, asyncio.Lock] = {}

    async def get_or_load(
        self,
        cache_key: str,
        ttl_seconds: float,
        loader: Callable[[], Awaitable[ResultType]],
    ) -> tuple[ResultType, bool]:
        """Return ``(value, was_cached)``; concurrent misses for one key load once."""
        cached_entry = self._entries.get(cache_key)
        if cached_entry is not None and cached_entry[0] > self._clock():
            return cached_entry[1], True
        key_lock = self._key_locks.setdefault(cache_key, asyncio.Lock())
        async with key_lock:
            cached_entry = self._entries.get(cache_key)
            if cached_entry is not None and cached_entry[0] > self._clock():
                return cached_entry[1], True
            loaded_value = await loader()
            self._entries[cache_key] = (self._clock() + ttl_seconds, loaded_value)
            return loaded_value, False


# --------------------------------------------------------------------------------------
# Finnhub HTTP client
# --------------------------------------------------------------------------------------


class FinnhubClient:
    def __init__(
        self,
        api_key: str,
        base_url: str,
        rate_limiter: SlidingWindowRateLimiter,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._rate_limiter = rate_limiter
        self._http_client = http_client or httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS)
        self._base_url = base_url.rstrip("/")
        self._auth_headers = {"X-Finnhub-Token": api_key}

    async def aclose(self) -> None:
        await self._http_client.aclose()

    async def get_json(self, path: str, query_params: dict[str, str] | None = None) -> Any:
        await self._rate_limiter.acquire()
        try:
            response = await self._http_client.get(
                f"{self._base_url}{path}", params=query_params, headers=self._auth_headers
            )
        except httpx.HTTPError as transport_error:
            raise ApiError(
                502,
                "finnhub_unavailable",
                f"Could not reach Finnhub ({type(transport_error).__name__})",
            ) from transport_error

        if response.status_code == 401:
            raise ApiError(502, "finnhub_unauthorized", "Finnhub rejected the configured API key")
        if response.status_code == 403:
            raise ApiError(
                402,
                "finnhub_premium_required",
                f"Finnhub endpoint {path} requires a paid Finnhub plan",
            )
        if response.status_code == 429:
            raise ApiError(503, "finnhub_rate_limited", "Finnhub rate limit reached; retry shortly")
        if response.status_code >= 400:
            raise ApiError(
                502, "finnhub_unavailable", f"Finnhub returned HTTP {response.status_code}"
            )
        try:
            return response.json()
        except ValueError as parse_error:
            raise ApiError(
                502, "finnhub_bad_response", "Finnhub returned invalid JSON"
            ) from parse_error


# --------------------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------------------


def _optional_float(raw_value: Any) -> float | None:
    if raw_value is None or raw_value == "":
        return None
    try:
        return float(raw_value)
    except (TypeError, ValueError):
        return None


def normalize_impact(raw_impact: Any) -> ImpactLevel:
    """Finnhub reports impact as 'low'/'medium'/'high' or 1-3; unknown maps to low."""
    if isinstance(raw_impact, int | float):
        return {3: ImpactLevel.HIGH, 2: ImpactLevel.MEDIUM}.get(int(raw_impact), ImpactLevel.LOW)
    impact_text = str(raw_impact or "").strip().lower()
    if impact_text in ("high", "3"):
        return ImpactLevel.HIGH
    if impact_text in ("medium", "moderate", "2"):
        return ImpactLevel.MEDIUM
    return ImpactLevel.LOW


def parse_release_time(raw_time: str) -> datetime:
    """Finnhub calendar times look like '2026-11-21 13:30:00' and are UTC."""
    parsed_time = datetime.fromisoformat(raw_time.strip().replace(" ", "T").replace("Z", "+00:00"))
    return parsed_time if parsed_time.tzinfo else parsed_time.replace(tzinfo=UTC)


def parse_economic_event(raw_event: dict[str, Any]) -> EconomicEvent | None:
    try:
        release_time = parse_release_time(str(raw_event["time"]))
    except (KeyError, ValueError):
        return None
    country = str(raw_event.get("country") or "").upper()
    event_name = str(raw_event.get("event") or "").strip()
    stable_identity = f"{country}|{event_name}|{release_time.isoformat()}"
    return EconomicEvent(
        id=hashlib.sha1(stable_identity.encode(), usedforsecurity=False).hexdigest()[:16],
        time=release_time,
        country=country,
        event=event_name,
        impact=normalize_impact(raw_event.get("impact")),
        actual=_optional_float(raw_event.get("actual")),
        estimate=_optional_float(raw_event.get("estimate")),
        previous=_optional_float(raw_event.get("prev", raw_event.get("previous"))),
        unit=(str(raw_event["unit"]) if raw_event.get("unit") else None),
    )


def parse_news_item(raw_item: dict[str, Any]) -> NewsItem | None:
    try:
        published_at = datetime.fromtimestamp(int(raw_item["datetime"]), tz=UTC)
        item_id = int(raw_item["id"])
    except (KeyError, TypeError, ValueError, OverflowError, OSError):
        return None
    headline = str(raw_item.get("headline") or "").strip()
    summary = str(raw_item.get("summary") or "").strip()
    related_symbols = [
        symbol.strip() for symbol in str(raw_item.get("related") or "").split(",") if symbol.strip()
    ]
    return NewsItem(
        id=item_id,
        published_at=published_at,
        headline=headline,
        summary=summary,
        source=str(raw_item.get("source") or ""),
        url=str(raw_item.get("url") or ""),
        category=str(raw_item.get("category") or ""),
        related=related_symbols,
        image=str(raw_item["image"]) if raw_item.get("image") else None,
        sentiment=score_headline(f"{headline}. {summary}"),
    )


def _validate_symbol(symbol: str) -> str:
    if not SYMBOL_PATTERN.fullmatch(symbol):
        raise ApiError(422, "invalid_symbol", "Symbol contains unsupported characters")
    return symbol.upper()


# --------------------------------------------------------------------------------------
# Service
# --------------------------------------------------------------------------------------


class MacroFeedService:
    def __init__(
        self,
        settings: Settings,
        broadcaster: WebSocketBroadcaster,
        http_client: httpx.AsyncClient | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._settings = settings
        self._broadcaster = broadcaster
        self._clock = clock
        self._cache = TtlCache()
        api_key = finnhub_key(settings)
        self._client = (
            None
            if api_key is None
            else FinnhubClient(
                api_key,
                settings.finnhub_base_url,
                SlidingWindowRateLimiter(settings.finnhub_calls_per_minute),
                http_client,
            )
        )
        self._alerted_event_ids: set[str] = set()
        self._seen_news_ids: set[int] | None = None
        self._calendar_polling_available = True

    @property
    def is_configured(self) -> bool:
        return self._client is not None

    def _require_client(self) -> FinnhubClient:
        if self._client is None:
            raise ApiError(
                503,
                "finnhub_not_configured",
                "Set FINNHUB_API_KEY to enable the economic calendar and news feed",
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()

    # --- Calendar --------------------------------------------------------------------

    async def get_calendar(
        self,
        from_date: date | None = None,
        to_date: date | None = None,
        minimum_impact: ImpactLevel | None = None,
        country: str | None = None,
    ) -> EconomicCalendarResponse:
        client = self._require_client()
        range_start = from_date or self._clock().date()
        range_end = to_date or range_start + timedelta(days=DEFAULT_CALENDAR_RANGE_DAYS)
        if range_end < range_start:
            raise ApiError(422, "invalid_date_range", "to_date must be on or after from_date")
        if (range_end - range_start).days > MAX_CALENDAR_RANGE_DAYS:
            raise ApiError(
                422,
                "invalid_date_range",
                f"Date range may span at most {MAX_CALENDAR_RANGE_DAYS} days",
            )

        async def load_calendar() -> list[EconomicEvent]:
            payload = await client.get_json(
                "/calendar/economic",
                {"from": range_start.isoformat(), "to": range_end.isoformat()},
            )
            raw_events = payload.get("economicCalendar", []) if isinstance(payload, dict) else []
            parsed_events = (parse_economic_event(raw_event) for raw_event in raw_events)
            return sorted(
                (event for event in parsed_events if event is not None),
                key=lambda event: event.time,
            )

        all_events, was_cached = await self._cache.get_or_load(
            f"calendar:{range_start}:{range_end}",
            self._settings.calendar_cache_seconds,
            load_calendar,
        )
        filtered_events = [
            event
            for event in all_events
            if (minimum_impact is None or IMPACT_RANK[event.impact] >= IMPACT_RANK[minimum_impact])
            and (country is None or event.country == country.upper())
        ]
        return EconomicCalendarResponse(
            from_date=range_start.isoformat(),
            to_date=range_end.isoformat(),
            count=len(filtered_events),
            events=filtered_events,
            cached=was_cached,
        )

    # --- News ------------------------------------------------------------------------

    async def get_news(
        self, category: str = "general", symbol: str | None = None, limit: int = 30
    ) -> NewsResponse:
        client = self._require_client()
        if symbol is not None:
            normalized_symbol = _validate_symbol(symbol)
            today = self._clock().date()
            cache_key = f"company-news:{normalized_symbol}:{today}"
            path = "/company-news"
            query_params = {
                "symbol": normalized_symbol,
                "from": (today - timedelta(days=COMPANY_NEWS_LOOKBACK_DAYS)).isoformat(),
                "to": today.isoformat(),
            }
            response_category = None
        else:
            if category not in NEWS_CATEGORIES:
                raise ApiError(
                    422, "invalid_category", f"category must be one of {', '.join(NEWS_CATEGORIES)}"
                )
            normalized_symbol = None
            cache_key = f"news:{category}"
            path = "/news"
            query_params = {"category": category}
            response_category = category

        async def load_news() -> list[NewsItem]:
            payload = await client.get_json(path, query_params)
            raw_items = payload if isinstance(payload, list) else []
            parsed_items = (parse_news_item(raw_item) for raw_item in raw_items)
            return sorted(
                (item for item in parsed_items if item is not None),
                key=lambda item: item.published_at,
                reverse=True,
            )

        news_items, was_cached = await self._cache.get_or_load(
            cache_key, self._settings.news_cache_seconds, load_news
        )
        limited_items = news_items[: max(1, min(limit, MAX_NEWS_ITEMS))]
        return NewsResponse(
            category=response_category,
            symbol=normalized_symbol,
            count=len(limited_items),
            items=limited_items,
            cached=was_cached,
        )

    async def get_symbol_sentiment(self, symbol: str) -> SymbolSentimentResponse:
        client = self._require_client()
        normalized_symbol = _validate_symbol(symbol)
        try:
            payload = await client.get_json("/news-sentiment", {"symbol": normalized_symbol})
        except ApiError as sentiment_error:
            if sentiment_error.error_code != "finnhub_premium_required":
                raise
            return await self._lexicon_symbol_sentiment(normalized_symbol)

        response_body = payload if isinstance(payload, dict) else {}
        sentiment_block = response_body.get("sentiment") or {}
        bullish_share = _optional_float(sentiment_block.get("bullishPercent"))
        bearish_share = _optional_float(sentiment_block.get("bearishPercent"))
        if bullish_share is None or bearish_share is None:
            return await self._lexicon_symbol_sentiment(normalized_symbol)
        score = max(-1.0, min(1.0, bullish_share - bearish_share))
        buzz_block = response_body.get("buzz") or {}
        return SymbolSentimentResponse(
            symbol=normalized_symbol,
            source="finnhub",
            bullish_pct=round(bullish_share * 100, 2),
            bearish_pct=round(bearish_share * 100, 2),
            score=round(score, 3),
            label=_label_for_score(score),
            articles_analysed=int(_optional_float(buzz_block.get("articlesInLastWeek")) or 0),
        )

    async def _lexicon_symbol_sentiment(self, symbol: str) -> SymbolSentimentResponse:
        company_news = await self.get_news(symbol=symbol, limit=MAX_NEWS_ITEMS)
        headline_scores = [item.sentiment.score for item in company_news.items]
        average_score = sum(headline_scores) / len(headline_scores) if headline_scores else 0.0
        scored_items = [item for item in company_news.items if item.sentiment.score != 0]
        bullish_count = sum(item.sentiment.score > 0 for item in scored_items)
        bearish_count = len(scored_items) - bullish_count
        return SymbolSentimentResponse(
            symbol=symbol,
            source="lexicon",
            bullish_pct=round(100 * bullish_count / len(scored_items), 2) if scored_items else None,
            bearish_pct=round(100 * bearish_count / len(scored_items), 2) if scored_items else None,
            score=round(average_score, 3),
            label=_label_for_score(average_score),
            articles_analysed=len(headline_scores),
            note="Finnhub news-sentiment requires a paid plan; scored recent headlines locally",
        )

    # --- Background poller -------------------------------------------------------------

    async def poll_once(self) -> None:
        """Broadcast upcoming high-impact releases and fresh headlines (one cycle)."""
        if self._calendar_polling_available:
            await self._announce_upcoming_events()
        await self._announce_fresh_news()

    async def _announce_upcoming_events(self) -> None:
        now = self._clock()
        try:
            calendar = await self.get_calendar(
                now.date(), now.date() + timedelta(days=1), minimum_impact=ImpactLevel.HIGH
            )
        except ApiError as calendar_error:
            if calendar_error.error_code == "finnhub_premium_required":
                logger.warning("Economic calendar needs a paid Finnhub plan; calendar alerts off")
                self._calendar_polling_available = False
                return
            raise
        lead_time = timedelta(minutes=self._settings.macro_alert_lead_minutes)
        for event in calendar.events:
            time_until_release = event.time - now
            if (
                timedelta(0) < time_until_release <= lead_time
                and event.id not in self._alerted_event_ids
            ):
                self._alerted_event_ids.add(event.id)
                minutes_until = max(1, round(time_until_release.total_seconds() / 60))
                await self._broadcaster.broadcast(
                    WsEventType.MACRO_EVENT_UPCOMING,
                    f"{event.country} {event.event} in {minutes_until} min",
                    MacroEventUpcomingData(event=event, minutes_until=minutes_until),
                )

    async def _announce_fresh_news(self) -> None:
        latest_news = await self.get_news(category="general", limit=MAX_NEWS_ITEMS)
        current_ids = {item.id for item in latest_news.items}
        if self._seen_news_ids is None:
            # First cycle only seeds the baseline so start-up does not flood the UI.
            self._seen_news_ids = current_ids
            return
        fresh_items = [item for item in latest_news.items if item.id not in self._seen_news_ids]
        self._seen_news_ids |= current_ids
        for item in fresh_items[:MAX_NEWS_FLASHES_PER_POLL]:
            await self._broadcaster.broadcast(
                WsEventType.NEWS_FLASH, item.headline, NewsFlashData(item=item)
            )

    async def run_poller(self) -> None:
        while True:
            try:
                await self.poll_once()
            except asyncio.CancelledError:
                raise
            except ApiError as poll_error:
                logger.warning(
                    "Macro poll failed: %s (%s)", poll_error.message, poll_error.error_code
                )
            except Exception:  # noqa: BLE001 - the poller must survive unexpected payloads
                logger.exception("Macro poll crashed; retrying next cycle")
            await asyncio.sleep(self._settings.macro_poll_seconds)


# --------------------------------------------------------------------------------------
# HTTP routes
# --------------------------------------------------------------------------------------


def _macro_service(request: Request) -> MacroFeedService:
    return request.app.state.macro_service


def build_router(auth_dependency: Callable[..., Any]) -> APIRouter:
    router = APIRouter(
        prefix="/api/v1/macro", tags=["macro"], dependencies=[Depends(auth_dependency)]
    )

    @router.get("/calendar", response_model=EconomicCalendarResponse)
    async def economic_calendar(
        request: Request,
        from_date: date | None = Query(default=None, alias="from"),
        to_date: date | None = Query(default=None, alias="to"),
        impact: ImpactLevel | None = Query(default=None, description="Minimum impact level"),
        country: str | None = Query(default=None, min_length=2, max_length=3),
    ) -> EconomicCalendarResponse:
        return await _macro_service(request).get_calendar(from_date, to_date, impact, country)

    @router.get("/news", response_model=NewsResponse)
    async def market_news(
        request: Request,
        category: str = Query(default="general"),
        symbol: str | None = Query(default=None, max_length=20),
        limit: int = Query(default=30, ge=1, le=MAX_NEWS_ITEMS),
    ) -> NewsResponse:
        return await _macro_service(request).get_news(category, symbol, limit)

    @router.get("/sentiment", response_model=SymbolSentimentResponse)
    async def symbol_sentiment(
        request: Request, symbol: str = Query(max_length=20)
    ) -> SymbolSentimentResponse:
        return await _macro_service(request).get_symbol_sentiment(symbol)

    return router
