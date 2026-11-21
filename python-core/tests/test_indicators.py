from __future__ import annotations

import math

import numpy as np
import pytest
from fastapi.testclient import TestClient

from errors import ApiError
from indicators import build_candle_frame, build_catalog, compute_indicators, scan_timeframes
from schemas import (
    Candle,
    IndicatorComputeRequest,
    MultiTimeframeScanRequest,
    SeriesStyle,
    SignalBias,
)

DAY_SECONDS = 86_400
FIRST_CANDLE_TIME = 1_700_000_000


def make_trending_candles(bar_count: int, drift_per_bar: float, seed: int = 7) -> list[Candle]:
    """Accelerating trend: the per-bar drift ramps from 0 to 2x ``drift_per_bar``.

    Acceleration keeps momentum (MACD) confirming the trend, like a clean impulsive move.
    """
    random_generator = np.random.default_rng(seed)
    close_price = 200.0
    candles: list[Candle] = []
    for bar_index in range(bar_count):
        open_price = close_price
        ramped_drift = drift_per_bar * 2 * bar_index / bar_count
        close_price = max(1.0, open_price + ramped_drift + random_generator.normal(0, 0.3))
        wick_size = abs(random_generator.normal(0, 0.4))
        candles.append(
            Candle(
                time=FIRST_CANDLE_TIME + bar_index * DAY_SECONDS,
                open=open_price,
                high=max(open_price, close_price) + wick_size,
                low=max(0.5, min(open_price, close_price) - wick_size),
                close=close_price,
                volume=1_000 + bar_index,
            )
        )
    return candles


def test_catalog_lists_core_indicators() -> None:
    catalog = build_catalog()
    catalog_by_name = {entry.name: entry for entry in catalog.indicators}
    assert catalog.count > 100
    for indicator_name in ("ema", "rsi", "macd", "bbands", "atr", "vwap"):
        assert indicator_name in catalog_by_name
    assert catalog_by_name["ema"].pane == "price"
    assert catalog_by_name["bbands"].pane == "price"
    assert catalog_by_name["rsi"].pane == "oscillator"
    assert "talib" not in catalog_by_name["ema"].params


def test_core_strategy_is_lightweight_charts_shaped() -> None:
    candles = make_trending_candles(260, drift_per_bar=0.4)
    response = compute_indicators(
        IndicatorComputeRequest(candles=candles, strategy="maison_core"),
        max_candles=20_000,
        max_indicators=32,
    )
    results_by_id = {result.id: result for result in response.indicators}
    assert set(results_by_id) == {
        "ema_9",
        "ema_21",
        "ema_50",
        "ema_200",
        "rsi_14",
        "macd_12_26_9",
        "bbands_20_2",
    }

    ema_21_points = results_by_id["ema_21"].series[0].data
    assert len(ema_21_points) == 260 - 20  # warm-up bars omitted, not null
    assert ema_21_points[0].time == candles[20].time
    assert all(math.isfinite(point.value) for point in ema_21_points)

    macd_styles = {series.key: series.style for series in results_by_id["macd_12_26_9"].series}
    assert macd_styles["MACDh_12_26_9"] == SeriesStyle.HISTOGRAM
    assert macd_styles["MACD_12_26_9"] == SeriesStyle.LINE
    assert results_by_id["rsi_14"].reference_lines == [30.0, 70.0]
    assert response.candles is not None and len(response.candles) == 260
    assert response.volume is not None
    assert response.summary is not None
    assert response.summary.bias == SignalBias.BULLISH


def test_downtrend_scores_bearish_and_scan_confluence() -> None:
    falling_candles = make_trending_candles(260, drift_per_bar=-0.3)
    rising_candles = make_trending_candles(260, drift_per_bar=0.4)
    scan_result = scan_timeframes(
        MultiTimeframeScanRequest(
            timeframes={"1h": falling_candles, "4h": falling_candles, "1D": rising_candles}
        ),
        max_candles=20_000,
    )
    biases = {result.timeframe: result.summary.bias for result in scan_result.results}
    assert biases["1h"] == SignalBias.BEARISH
    assert biases["1D"] == SignalBias.BULLISH
    assert scan_result.confluence_bias == SignalBias.BEARISH
    assert scan_result.aligned_timeframes == 2


def test_business_day_times_are_echoed() -> None:
    candles = [
        Candle(time=f"2026-01-{day:02d}", open=10, high=14, low=9, close=10 + day / 10)
        for day in range(1, 29)
    ]
    response = compute_indicators(
        IndicatorComputeRequest(
            candles=candles, indicators=[{"name": "sma", "params": {"length": 5}}]
        ),
        max_candles=20_000,
        max_indicators=32,
    )
    assert response.indicators[0].series[0].data[0].time == "2026-01-05"
    assert response.volume is None


def test_unsorted_candles_are_sorted() -> None:
    candles = make_trending_candles(30, drift_per_bar=0.1)
    candle_frame = build_candle_frame(list(reversed(candles)))
    assert candle_frame["chart_time"].iloc[0] == candles[0].time


@pytest.mark.parametrize(
    ("indicator", "expected_code"),
    [
        ({"name": "not_real"}, "unknown_indicator"),
        ({"name": "ema", "params": {"talib": True}}, "unknown_indicator_param"),
        ({"name": "ema", "params": {"lenght": 5}}, "unknown_indicator_param"),
    ],
)
def test_rejects_bad_indicator_specs(indicator: dict, expected_code: str) -> None:
    with pytest.raises(ApiError) as raised:
        compute_indicators(
            IndicatorComputeRequest(candles=make_trending_candles(30, 0.1), indicators=[indicator]),
            max_candles=20_000,
            max_indicators=32,
        )
    assert raised.value.error_code == expected_code


def test_rejects_duplicates_and_mixed_times() -> None:
    candle = make_trending_candles(1, 0.1)[0]
    with pytest.raises(ApiError) as duplicate_error:
        build_candle_frame([candle, candle])
    assert duplicate_error.value.error_code == "duplicate_candle_time"

    business_day_candle = candle.model_copy(update={"time": "2026-01-01"})
    with pytest.raises(ApiError) as mixed_error:
        build_candle_frame([candle, business_day_candle])
    assert mixed_error.value.error_code == "mixed_time_formats"


def test_volume_indicator_requires_volume() -> None:
    candles = [
        candle.model_copy(update={"volume": None}) for candle in make_trending_candles(30, 0.1)
    ]
    with pytest.raises(ApiError) as raised:
        compute_indicators(
            IndicatorComputeRequest(candles=candles, indicators=[{"name": "obv"}]),
            max_candles=20_000,
            max_indicators=32,
        )
    assert raised.value.error_code == "volume_required"


def test_candle_limit() -> None:
    with pytest.raises(ApiError) as raised:
        compute_indicators(
            IndicatorComputeRequest(candles=make_trending_candles(30, 0.1), strategy="maison_core"),
            max_candles=10,
            max_indicators=32,
        )
    assert raised.value.status_code == 413


def test_endpoints(client: TestClient) -> None:
    assert client.get("/api/v1/indicators").json()["count"] > 100
    candles = [candle.model_dump() for candle in make_trending_candles(60, 0.2)]
    compute_response = client.post(
        "/api/v1/indicators/compute",
        json={"candles": candles, "indicators": [{"name": "rsi", "params": {"length": 14}}]},
    )
    assert compute_response.status_code == 200
    assert compute_response.json()["indicators"][0]["series"][0]["key"] == "RSI_14"

    scan_response = client.post("/api/v1/indicators/scan", json={"timeframes": {"1h": candles}})
    assert scan_response.status_code == 200
    assert scan_response.json()["total_timeframes"] == 1

    error_response = client.post(
        "/api/v1/indicators/compute", json={"candles": candles, "indicators": [{"name": "nope"}]}
    )
    assert error_response.json()["error"]["code"] == "unknown_indicator"
