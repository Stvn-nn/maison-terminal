from __future__ import annotations

import json
from datetime import UTC, date, datetime

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from errors import ApiError
from main import create_app
from news_feed import (
    MacroFeedService,
    SlidingWindowRateLimiter,
    TtlCache,
    normalize_impact,
    parse_economic_event,
    parse_news_item,
    score_headline,
)
from schemas import ImpactLevel, SentimentLabel
from tests.conftest import build_test_settings
from ws import WebSocketBroadcaster

FINNHUB_BASE_URL = "https://finnhub.test/api/v1"
FAKE_API_KEY = "fake-finnhub-key"  # noqa: S105 - fixture value only
FROZEN_NOW = datetime(2026, 11, 21, 13, 20, tzinfo=UTC)

CALENDAR_PAYLOAD = {
    "economicCalendar": [
        {
            "actual": None,
            "country": "US",
            "estimate": 3.1,
            "event": "CPI YoY",
            "impact": "high",
            "prev": 3.3,
            "time": "2026-11-21 13:30:00",
            "unit": "%",
        },
        {
            "actual": 52.1,
            "country": "EU",
            "estimate": 51.8,
            "event": "PMI",
            "impact": "medium",
            "prev": 51.0,
            "time": "2026-11-21 09:00:00",
            "unit": "",
        },
        {"country": "JP", "event": "Broken row", "impact": "low", "time": "not-a-time"},
    ]
}
NEWS_PAYLOAD = [
    {
        "category": "general",
        "datetime": 1_795_000_000,
        "headline": "Stocks surge to record on strong earnings",
        "id": 101,
        "image": "",
        "related": "AAPL,MSFT",
        "source": "Wire",
        "summary": "",
        "url": "https://n.test/1",
    },
    {
        "category": "general",
        "datetime": 1_795_000_100,
        "headline": "Bank warns of recession risk as profits plunge",
        "id": 102,
        "image": "https://img.test/2.png",
        "related": "",
        "source": "Wire",
        "summary": "",
        "url": "https://n.test/2",
    },
]


class RecordingSocket:
    def __init__(self) -> None:
        self.frames: list[dict] = []

    async def send_text(self, payload: str) -> None:
        self.frames.append(json.loads(payload))


def make_service(
    broadcaster: WebSocketBroadcaster | None = None, **setting_overrides: object
) -> MacroFeedService:
    settings = build_test_settings(
        finnhub_api_key=FAKE_API_KEY,
        finnhub_base_url=FINNHUB_BASE_URL,
        **setting_overrides,
    )
    return MacroFeedService(
        settings, broadcaster or WebSocketBroadcaster(), clock=lambda: FROZEN_NOW
    )


class TestParsing:
    def test_economic_event_normalisation(self) -> None:
        event = parse_economic_event(CALENDAR_PAYLOAD["economicCalendar"][0])
        assert event is not None
        assert event.time == datetime(2026, 11, 21, 13, 30, tzinfo=UTC)
        assert event.impact == ImpactLevel.HIGH
        assert event.previous == 3.3 and event.actual is None
        assert len(event.id) == 16
        assert parse_economic_event(CALENDAR_PAYLOAD["economicCalendar"][2]) is None

    @pytest.mark.parametrize(
        ("raw_impact", "expected"),
        [
            ("high", "high"),
            ("Medium", "medium"),
            (3, "high"),
            (2, "medium"),
            (None, "low"),
            ("?", "low"),
        ],
    )
    def test_impact_levels(self, raw_impact: object, expected: str) -> None:
        assert normalize_impact(raw_impact) == expected

    def test_news_item_and_sentiment(self) -> None:
        bullish_item = parse_news_item(NEWS_PAYLOAD[0])
        bearish_item = parse_news_item(NEWS_PAYLOAD[1])
        assert bullish_item is not None and bearish_item is not None
        assert bullish_item.related == ["AAPL", "MSFT"]
        assert bullish_item.image is None
        assert bullish_item.sentiment.label == SentimentLabel.BULLISH
        assert bearish_item.sentiment.label == SentimentLabel.BEARISH
        assert parse_news_item({"headline": "no id"}) is None

    def test_neutral_headline(self) -> None:
        assert score_headline("Committee meets on Tuesday").label == SentimentLabel.NEUTRAL


class TestInfrastructure:
    async def test_ttl_cache_expires(self) -> None:
        fake_now = [0.0]
        cache = TtlCache(clock=lambda: fake_now[0])
        load_count = 0

        async def loader() -> int:
            nonlocal load_count
            load_count += 1
            return load_count

        assert await cache.get_or_load("key", 10, loader) == (1, False)
        assert await cache.get_or_load("key", 10, loader) == (1, True)
        fake_now[0] = 11
        assert await cache.get_or_load("key", 10, loader) == (2, False)

    async def test_rate_limiter_admits_up_to_limit(self) -> None:
        limiter = SlidingWindowRateLimiter(max_calls=3, window_seconds=60)
        for _ in range(3):
            await limiter.acquire()  # must not block


@respx.mock(base_url=FINNHUB_BASE_URL)
class TestMacroFeedService:
    async def test_calendar_filters_by_impact_and_caches(
        self, respx_mock: respx.MockRouter
    ) -> None:
        calendar_route = respx_mock.get("/calendar/economic").respond(json=CALENDAR_PAYLOAD)
        service = make_service()
        high_impact = await service.get_calendar(minimum_impact=ImpactLevel.HIGH)
        assert [event.event for event in high_impact.events] == ["CPI YoY"]
        assert high_impact.cached is False
        assert high_impact.from_date == "2026-11-21" and high_impact.to_date == "2026-11-28"

        everything = await service.get_calendar()
        assert everything.count == 2 and everything.cached is True
        assert calendar_route.call_count == 1
        sent_request = calendar_route.calls.last.request
        assert sent_request.headers["X-Finnhub-Token"] == FAKE_API_KEY
        assert FAKE_API_KEY not in str(sent_request.url)
        await service.aclose()

    async def test_premium_endpoint_maps_to_402(self, respx_mock: respx.MockRouter) -> None:
        respx_mock.get("/calendar/economic").respond(status_code=403, json={"error": "no access"})
        service = make_service()
        with pytest.raises(ApiError) as raised:
            await service.get_calendar()
        assert raised.value.status_code == 402
        assert raised.value.error_code == "finnhub_premium_required"
        await service.aclose()

    @pytest.mark.parametrize(
        ("upstream_status", "expected_code"),
        [
            (401, "finnhub_unauthorized"),
            (429, "finnhub_rate_limited"),
            (500, "finnhub_unavailable"),
        ],
    )
    async def test_upstream_errors(
        self, respx_mock: respx.MockRouter, upstream_status: int, expected_code: str
    ) -> None:
        respx_mock.get("/news").respond(status_code=upstream_status)
        service = make_service()
        with pytest.raises(ApiError) as raised:
            await service.get_news()
        assert raised.value.error_code == expected_code
        await service.aclose()

    async def test_network_failure(self, respx_mock: respx.MockRouter) -> None:
        respx_mock.get("/news").mock(side_effect=httpx.ConnectError("offline"))
        service = make_service()
        with pytest.raises(ApiError) as raised:
            await service.get_news()
        assert raised.value.error_code == "finnhub_unavailable"
        await service.aclose()

    async def test_news_sorted_newest_first(self, respx_mock: respx.MockRouter) -> None:
        respx_mock.get("/news").respond(json=NEWS_PAYLOAD)
        service = make_service()
        news = await service.get_news(limit=10)
        assert [item.id for item in news.items] == [102, 101]
        await service.aclose()

    async def test_sentiment_from_finnhub(self, respx_mock: respx.MockRouter) -> None:
        respx_mock.get("/news-sentiment").respond(
            json={
                "symbol": "AAPL",
                "sentiment": {"bullishPercent": 0.7, "bearishPercent": 0.3},
                "buzz": {"articlesInLastWeek": 42},
            }
        )
        service = make_service()
        sentiment = await service.get_symbol_sentiment("aapl")
        assert sentiment.source == "finnhub"
        assert sentiment.score == 0.4
        assert sentiment.label == SentimentLabel.BULLISH
        assert sentiment.articles_analysed == 42
        await service.aclose()

    async def test_sentiment_falls_back_to_lexicon(self, respx_mock: respx.MockRouter) -> None:
        respx_mock.get("/news-sentiment").respond(status_code=403)
        company_news_route = respx_mock.get("/company-news").respond(json=NEWS_PAYLOAD)
        service = make_service()
        sentiment = await service.get_symbol_sentiment("AAPL")
        assert sentiment.source == "lexicon"
        assert sentiment.articles_analysed == 2
        assert sentiment.note
        assert company_news_route.calls.last.request.url.params["symbol"] == "AAPL"
        await service.aclose()

    async def test_poller_alerts_once_and_flashes_only_new_news(
        self, respx_mock: respx.MockRouter
    ) -> None:
        respx_mock.get("/calendar/economic").respond(json=CALENDAR_PAYLOAD)
        news_route = respx_mock.get("/news").respond(json=NEWS_PAYLOAD[:1])
        broadcaster = WebSocketBroadcaster()
        recording_socket = RecordingSocket()
        await broadcaster.register(recording_socket)  # type: ignore[arg-type]
        service = make_service(broadcaster, news_cache_seconds=0, calendar_cache_seconds=0)

        await service.poll_once()  # CPI is 10 min away -> alert; news seeds baseline
        news_route.respond(json=NEWS_PAYLOAD)
        await service.poll_once()  # no repeat alert; one fresh headline

        events = [frame["event"] for frame in recording_socket.frames]
        assert events == ["MACRO_EVENT_UPCOMING", "NEWS_FLASH"]
        assert recording_socket.frames[0]["data"]["minutes_until"] == 10
        assert recording_socket.frames[0]["message"] == "US CPI YoY in 10 min"
        assert recording_socket.frames[1]["data"]["item"]["id"] == 102
        await service.aclose()

    async def test_poller_disables_calendar_on_free_plan(
        self, respx_mock: respx.MockRouter
    ) -> None:
        calendar_route = respx_mock.get("/calendar/economic").respond(status_code=403)
        respx_mock.get("/news").respond(json=NEWS_PAYLOAD)
        service = make_service(calendar_cache_seconds=0)
        await service.poll_once()
        await service.poll_once()
        assert calendar_route.call_count == 1
        await service.aclose()


def test_validation_errors() -> None:
    service = make_service()
    with pytest.raises(ApiError) as range_error:
        import asyncio

        asyncio.run(service.get_calendar(date(2026, 1, 1), date(2026, 3, 1)))
    assert range_error.value.error_code == "invalid_date_range"


class TestMacroEndpoints:
    def test_not_configured_returns_503(self, client: TestClient) -> None:
        response = client.get("/api/v1/macro/calendar")
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "finnhub_not_configured"

    def test_calendar_endpoint(self) -> None:
        settings = build_test_settings(
            finnhub_api_key=FAKE_API_KEY, finnhub_base_url=FINNHUB_BASE_URL
        )
        with respx.mock(base_url=FINNHUB_BASE_URL, assert_all_called=False) as respx_mock:
            respx_mock.get("/calendar/economic").respond(json=CALENDAR_PAYLOAD)
            with TestClient(create_app(settings)) as configured_client:
                response = configured_client.get(
                    "/api/v1/macro/calendar",
                    params={
                        "from": "2026-11-21",
                        "to": "2026-11-22",
                        "impact": "high",
                        "country": "us",
                    },
                )
                assert response.status_code == 200
                body = response.json()
                assert body["count"] == 1
                assert body["events"][0]["impact"] == "high"
                assert configured_client.get("/health").json()["finnhub_configured"] is True

    def test_invalid_category(self) -> None:
        settings = build_test_settings(
            finnhub_api_key=FAKE_API_KEY, finnhub_base_url=FINNHUB_BASE_URL
        )
        with TestClient(create_app(settings)) as configured_client:
            response = configured_client.get("/api/v1/macro/news", params={"category": "sports"})
            assert response.json()["error"]["code"] == "invalid_category"
