"""Symbol search and real price history (Yahoo Finance public endpoints, no API key).

Used when the user picks a pair instead of (or as well as) reading the chart off the
screen, so the app shows real prices that keep updating. Yahoo's endpoints are unofficial
and quotes may be delayed; responses say so, and nothing here is cached for long.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any, Literal

import httpx
from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel

from errors import ApiError
from schemas import Candle

SEARCH_URL = "https://query2.finance.yahoo.com/v1/finance/search"
CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
REQUEST_HEADERS = {"User-Agent": "Mozilla/5.0 (desktop charting client)"}
SEARCH_CACHE_SECONDS = 300
CANDLE_CACHE_SECONDS = 15
DATA_SOURCE_NOTE = "Yahoo Finance (unofficial public data; may be delayed)"

AssetKind = Literal["stock", "etf", "index", "forex", "crypto", "future", "fund", "other"]
QUOTE_TYPE_KINDS: dict[str, AssetKind] = {
    "EQUITY": "stock",
    "ETF": "etf",
    "INDEX": "index",
    "CURRENCY": "forex",
    "CRYPTOCURRENCY": "crypto",
    "FUTURE": "future",
    "MUTUALFUND": "fund",
}
# Timeframe -> (Yahoo interval, history range). Yahoo caps intraday history: 1m bars go
# back about a week, 5m-30m about 60 days, 1h about two years.
TIMEFRAMES: dict[str, tuple[str, str]] = {
    "1m": ("1m", "5d"),
    "5m": ("5m", "1mo"),
    "15m": ("15m", "1mo"),
    "30m": ("30m", "1mo"),
    "1h": ("1h", "6mo"),
    "1d": ("1d", "2y"),
    "1w": ("1wk", "10y"),
    "1M": ("1mo", "max"),
}


class SymbolMatch(BaseModel):
    symbol: str
    name: str
    kind: AssetKind
    exchange: str | None


class SymbolSearchResponse(BaseModel):
    query: str
    matches: list[SymbolMatch]
    source: str = DATA_SOURCE_NOTE


class MarketCandlesResponse(BaseModel):
    symbol: str
    name: str | None
    kind: AssetKind
    currency: str | None
    exchange: str | None
    interval: str
    last_price: float | None
    candles: list[Candle]
    source: str = DATA_SOURCE_NOTE


class MarketDataService:
    def __init__(self, http_client: httpx.AsyncClient | None = None) -> None:
        self._http_client = http_client or httpx.AsyncClient(timeout=10.0, headers=REQUEST_HEADERS)
        self._response_cache: dict[str, tuple[float, Any]] = {}

    async def aclose(self) -> None:
        await self._http_client.aclose()

    async def _get_json(self, url: str, query_params: dict[str, Any], cache_seconds: float) -> Any:
        cache_key = f"{url}?{sorted(query_params.items())}"
        cached_entry = self._response_cache.get(cache_key)
        if cached_entry and cached_entry[0] > time.monotonic():
            return cached_entry[1]
        try:
            response = await self._http_client.get(url, params=query_params)
        except httpx.HTTPError as transport_error:
            raise ApiError(
                502, "market_data_unavailable", "Price data provider unreachable"
            ) from transport_error
        if response.status_code == 404:
            raise ApiError(404, "unknown_symbol", "No price data for that symbol")
        if response.status_code >= 400:
            raise ApiError(
                502,
                "market_data_unavailable",
                f"Price data provider returned {response.status_code}",
            )
        payload = response.json()
        self._response_cache[cache_key] = (time.monotonic() + cache_seconds, payload)
        return payload

    async def search(self, query: str) -> SymbolSearchResponse:
        payload = await self._get_json(
            SEARCH_URL,
            {"q": query, "quotesCount": 10, "newsCount": 0, "listsCount": 0},
            SEARCH_CACHE_SECONDS,
        )
        matches = [
            SymbolMatch(
                symbol=quote["symbol"],
                name=quote.get("shortname") or quote.get("longname") or quote["symbol"],
                kind=QUOTE_TYPE_KINDS.get(str(quote.get("quoteType", "")).upper(), "other"),
                exchange=quote.get("exchDisp") or quote.get("exchange"),
            )
            for quote in payload.get("quotes", [])
            if quote.get("symbol")
        ]
        return SymbolSearchResponse(query=query, matches=matches)

    async def candles(self, symbol: str, interval: str) -> MarketCandlesResponse:
        if interval not in TIMEFRAMES:
            raise ApiError(422, "invalid_interval", f"interval must be one of {list(TIMEFRAMES)}")
        yahoo_interval, history_range = TIMEFRAMES[interval]
        payload = await self._get_json(
            CHART_URL.format(symbol=symbol),
            {"interval": yahoo_interval, "range": history_range, "includePrePost": "false"},
            CANDLE_CACHE_SECONDS,
        )
        results = (payload.get("chart") or {}).get("result") or []
        if not results:
            raise ApiError(404, "unknown_symbol", "No price data for that symbol")
        chart_result = results[0]
        meta = chart_result.get("meta") or {}
        quote_series = ((chart_result.get("indicators") or {}).get("quote") or [{}])[0]
        timestamps = chart_result.get("timestamp") or []

        def series_value(field_name: str, bar_index: int) -> float | None:
            field_values = quote_series.get(field_name) or []
            return field_values[bar_index] if bar_index < len(field_values) else None

        candles: list[Candle] = []
        for bar_index, timestamp in enumerate(timestamps):
            bar_prices = [
                series_value(field_name, bar_index)
                for field_name in ("open", "high", "low", "close")
            ]
            if any(price is None or price <= 0 for price in bar_prices):
                continue  # Yahoo leaves gaps as nulls; never invent a bar
            open_price, high_price, low_price, close_price = bar_prices
            volume = series_value("volume", bar_index)
            candles.append(
                Candle(
                    time=int(timestamp),
                    open=open_price,
                    high=max(high_price, open_price, close_price),
                    low=min(low_price, open_price, close_price),
                    close=close_price,
                    volume=volume if volume is not None and volume >= 0 else None,
                )
            )
        if len(candles) < 2:
            raise ApiError(404, "no_price_history", "Not enough price history for that symbol")
        return MarketCandlesResponse(
            symbol=meta.get("symbol", symbol),
            name=meta.get("shortName") or meta.get("longName"),
            kind=QUOTE_TYPE_KINDS.get(str(meta.get("instrumentType", "")).upper(), "other"),
            currency=meta.get("currency"),
            exchange=meta.get("fullExchangeName") or meta.get("exchangeName"),
            interval=interval,
            last_price=meta.get("regularMarketPrice"),
            candles=candles,
        )


def build_router(auth_dependency: Callable[..., Any]) -> APIRouter:
    router = APIRouter(
        prefix="/api/v1/market", tags=["market"], dependencies=[Depends(auth_dependency)]
    )

    @router.get("/search", response_model=SymbolSearchResponse)
    async def search_symbols(
        request: Request, q: str = Query(min_length=1, max_length=40)
    ) -> SymbolSearchResponse:
        return await request.app.state.market_data.search(q.strip())

    @router.get("/candles", response_model=MarketCandlesResponse)
    async def market_candles(
        request: Request,
        symbol: str = Query(min_length=1, max_length=30, pattern=r"^[A-Za-z0-9.=^\-_:]+$"),
        interval: str = Query(default="5m"),
    ) -> MarketCandlesResponse:
        return await request.app.state.market_data.candles(symbol, interval)

    return router
