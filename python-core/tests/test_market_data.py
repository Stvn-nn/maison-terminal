from __future__ import annotations

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from errors import ApiError
from market_data import CHART_URL, SEARCH_URL, MarketDataService

SEARCH_PAYLOAD = {
    "quotes": [
        {"symbol": "EURUSD=X", "shortname": "EUR/USD", "quoteType": "CURRENCY", "exchDisp": "CCY"},
        {"symbol": "AAPL", "longname": "Apple Inc.", "quoteType": "EQUITY", "exchange": "NMS"},
        {"symbol": "XYZ", "quoteType": "OPTION"},
        {"shortname": "no symbol, skipped"},
    ]
}

CHART_PAYLOAD = {
    "chart": {
        "result": [
            {
                "meta": {
                    "symbol": "^GSPC",
                    "shortName": "S&P 500",
                    "instrumentType": "INDEX",
                    "currency": "USD",
                    "fullExchangeName": "SNP",
                    "regularMarketPrice": 6910.39,
                },
                "timestamp": [1_700_000_000, 1_700_000_300, 1_700_000_600, 1_700_000_900],
                "indicators": {
                    "quote": [
                        {
                            "open": [100.0, None, 101.0, 102.0],
                            "high": [101.0, None, 102.5, 101.0],  # last high below close
                            "low": [99.5, None, 100.5, 101.5],
                            "close": [100.5, None, 102.0, 102.5],
                            "volume": [10, None, 0, None],
                        }
                    ]
                },
            }
        ]
    }
}


@pytest.fixture
async def market_service():
    service = MarketDataService(httpx.AsyncClient())
    yield service
    await service.aclose()


class TestSymbolSearch:
    @respx.mock
    async def test_maps_quote_types_and_skips_entries_without_symbol(self, market_service):
        respx.get(SEARCH_URL).respond(json=SEARCH_PAYLOAD)
        result = await market_service.search("eur")
        assert [(match.symbol, match.kind) for match in result.matches] == [
            ("EURUSD=X", "forex"),
            ("AAPL", "stock"),
            ("XYZ", "other"),
        ]
        assert result.matches[1].name == "Apple Inc."
        assert result.matches[2].name == "XYZ"
        assert "Yahoo" in result.source

    @respx.mock
    async def test_repeated_search_is_served_from_cache(self, market_service):
        search_route = respx.get(SEARCH_URL).respond(json=SEARCH_PAYLOAD)
        await market_service.search("eur")
        await market_service.search("eur")
        assert search_route.call_count == 1


class TestMarketCandles:
    @respx.mock
    async def test_skips_null_bars_and_keeps_prices_consistent(self, market_service):
        respx.get(CHART_URL.format(symbol="^GSPC")).respond(json=CHART_PAYLOAD)
        result = await market_service.candles("^GSPC", "5m")
        assert result.kind == "index"
        assert result.last_price == 6910.39
        assert [candle.time for candle in result.candles] == [
            1_700_000_000,
            1_700_000_600,
            1_700_000_900,
        ]
        assert result.candles[-1].high == 102.5  # widened to contain the close
        assert result.candles[0].volume == 10
        assert result.candles[-1].volume is None

    @respx.mock
    async def test_unknown_symbol_maps_to_404(self, market_service):
        respx.get(CHART_URL.format(symbol="NOPE")).respond(status_code=404)
        with pytest.raises(ApiError) as raised:
            await market_service.candles("NOPE", "5m")
        assert raised.value.status_code == 404

    @respx.mock
    async def test_provider_outage_maps_to_502(self, market_service):
        respx.get(CHART_URL.format(symbol="AAPL")).mock(side_effect=httpx.ConnectError("down"))
        with pytest.raises(ApiError) as raised:
            await market_service.candles("AAPL", "5m")
        assert raised.value.status_code == 502

    async def test_rejects_unsupported_interval(self, market_service):
        with pytest.raises(ApiError) as raised:
            await market_service.candles("AAPL", "7m")
        assert raised.value.status_code == 422


class TestMarketRoutes:
    def test_symbol_parameter_is_validated(self, client: TestClient) -> None:
        response = client.get("/api/v1/market/candles", params={"symbol": "../etc"})
        assert response.status_code == 422

    def test_search_requires_a_query(self, client: TestClient) -> None:
        assert client.get("/api/v1/market/search", params={"q": ""}).status_code == 422
