"""pandas-ta strategy engine, formatted for TradingView Lightweight Charts.

Every computed column becomes a :class:`schemas.ChartSeries` whose points are
``{"time": <same form the client sent>, "value": float}``. Warm-up bars (NaN) are
omitted rather than sent as nulls, which is what Lightweight Charts expects.
"""

from __future__ import annotations

import inspect
import logging
import math
import warnings
from collections.abc import Callable
from functools import lru_cache
from typing import Any

import numpy as np
import pandas as pd
import pandas_ta_classic as ta
from fastapi import APIRouter, Depends, Request

from errors import ApiError
from schemas import (
    Candle,
    CandlestickPoint,
    ChartPane,
    ChartSeries,
    ChartTime,
    IndicatorCatalogEntry,
    IndicatorCatalogResponse,
    IndicatorComputeRequest,
    IndicatorComputeResponse,
    IndicatorResult,
    IndicatorSpec,
    LinePoint,
    MultiTimeframeScanRequest,
    MultiTimeframeScanResponse,
    SeriesStyle,
    SignalBias,
    StrategyPreset,
    StrategySignal,
    StrategySummary,
    TimeframeScanResult,
)

logger = logging.getLogger("maison.indicators")

# Map pandas-ta input parameter names to our OHLCV column names.
OHLCV_INPUT_COLUMNS: dict[str, str] = {
    "open_": "open",
    "open": "open",
    "high": "high",
    "low": "low",
    "close": "close",
    "volume": "volume",
}
# Parameters that are implementation details, never accepted from clients.
BLOCKED_PARAMS = frozenset({"talib", "kwargs", "args"})
UNSUPPORTED_CATEGORIES = frozenset({"candles", "performance"})

# Overlays that pandas-ta files under categories other than "overlap".
PRICE_PANE_EXTRAS = frozenset(
    {"bbands", "kc", "donchian", "accbands", "aberration", "psar", "hwc", "chandelier_exit"}
)
# "overlap" members that are really oscillators.
OSCILLATOR_OVERRIDES = frozenset({"linregangle", "linregslope"})

REFERENCE_LINES: dict[str, list[float]] = {
    "rsi": [30.0, 70.0],
    "stoch": [20.0, 80.0],
    "stochrsi": [20.0, 80.0],
    "mfi": [20.0, 80.0],
    "willr": [-80.0, -20.0],
    "cci": [-100.0, 100.0],
    "macd": [0.0],
    "ppo": [0.0],
    "ao": [0.0],
}
HISTOGRAM_COLUMN_PREFIXES = ("MACDh", "PPOh", "AO_", "SQZ_")

MAISON_CORE_SPECS: tuple[IndicatorSpec, ...] = (
    IndicatorSpec(id="ema_9", name="ema", params={"length": 9}),
    IndicatorSpec(id="ema_21", name="ema", params={"length": 21}),
    IndicatorSpec(id="ema_50", name="ema", params={"length": 50}),
    IndicatorSpec(id="ema_200", name="ema", params={"length": 200}),
    IndicatorSpec(id="rsi_14", name="rsi", params={"length": 14}),
    IndicatorSpec(id="macd_12_26_9", name="macd", params={"fast": 12, "slow": 26, "signal": 9}),
    IndicatorSpec(id="bbands_20_2", name="bbands", params={"length": 20, "std": 2.0}),
)
STRATEGY_PRESETS: dict[StrategyPreset, tuple[IndicatorSpec, ...]] = {
    StrategyPreset.MAISON_CORE: MAISON_CORE_SPECS,
}

RSI_OVERBOUGHT = 70.0
RSI_OVERSOLD = 30.0
RECENT_CROSS_LOOKBACK_BARS = 3
BIAS_SCORE_THRESHOLD = 2


# --------------------------------------------------------------------------------------
# Catalog
# --------------------------------------------------------------------------------------


class _IndicatorDefinition:
    def __init__(
        self,
        name: str,
        category: str,
        function: Callable[..., Any],
        input_params: list[str],
        tunable_params: list[str],
    ) -> None:
        self.name = name
        self.category = category
        self.function = function
        self.input_params = input_params
        self.tunable_params = tunable_params

    @property
    def pane(self) -> ChartPane:
        if self.name in OSCILLATOR_OVERRIDES:
            return ChartPane.OSCILLATOR
        if self.category == "overlap" or self.name in PRICE_PANE_EXTRAS:
            return ChartPane.PRICE
        return ChartPane.OSCILLATOR


def _inspect_indicator(name: str, category: str) -> _IndicatorDefinition | None:
    function = getattr(ta, name, None)
    if not callable(function):
        return None
    try:
        signature = inspect.signature(function)
    except (TypeError, ValueError):
        return None

    input_params: list[str] = []
    tunable_params: list[str] = []
    for parameter in signature.parameters.values():
        if parameter.kind in (parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD):
            continue
        if parameter.name in OHLCV_INPUT_COLUMNS:
            input_params.append(parameter.name)
        elif parameter.default is inspect.Parameter.empty:
            return None  # needs an input we cannot supply (e.g. a second series)
        elif parameter.name not in BLOCKED_PARAMS:
            tunable_params.append(parameter.name)
    if not input_params:
        return None
    return _IndicatorDefinition(name, category, function, input_params, tunable_params)


@lru_cache(maxsize=1)
def indicator_registry() -> dict[str, _IndicatorDefinition]:
    registry: dict[str, _IndicatorDefinition] = {}
    for category, indicator_names in ta.Category.items():
        if category in UNSUPPORTED_CATEGORIES:
            continue
        for indicator_name in indicator_names:
            definition = _inspect_indicator(indicator_name, category)
            if definition is not None:
                registry[indicator_name] = definition
    return registry


def build_catalog() -> IndicatorCatalogResponse:
    entries = [
        IndicatorCatalogEntry(
            name=definition.name,
            category=definition.category,
            pane=definition.pane,
            inputs=[OHLCV_INPUT_COLUMNS[param] for param in definition.input_params],
            params=definition.tunable_params,
        )
        for definition in sorted(indicator_registry().values(), key=lambda item: item.name)
    ]
    return IndicatorCatalogResponse(count=len(entries), indicators=entries)


# --------------------------------------------------------------------------------------
# Candle frame
# --------------------------------------------------------------------------------------


def _chart_time_to_timestamp(chart_time: ChartTime) -> pd.Timestamp:
    if isinstance(chart_time, bool):
        raise ApiError(422, "invalid_candle_time", "Candle time must be a number or YYYY-MM-DD")
    if isinstance(chart_time, int):
        return pd.Timestamp(chart_time, unit="s", tz="UTC")
    try:
        return pd.Timestamp(pd.to_datetime(chart_time, format="%Y-%m-%d", utc=True))
    except (ValueError, TypeError) as parse_error:
        raise ApiError(
            422, "invalid_candle_time", f"Unrecognised candle time {chart_time!r}"
        ) from parse_error


def build_candle_frame(candles: list[Candle]) -> pd.DataFrame:
    """Convert candles to a time-sorted OHLCV frame with a UTC DatetimeIndex.

    The original client time values are kept in the ``chart_time`` column so they can be
    echoed back unchanged.
    """
    time_kinds = {type(candle.time) for candle in candles}
    if len(time_kinds) > 1:
        raise ApiError(422, "mixed_time_formats", "All candle times must use the same format")
    candle_frame = pd.DataFrame(
        {
            "chart_time": [candle.time for candle in candles],
            "open": [candle.open for candle in candles],
            "high": [candle.high for candle in candles],
            "low": [candle.low for candle in candles],
            "close": [candle.close for candle in candles],
            "volume": [np.nan if candle.volume is None else candle.volume for candle in candles],
        },
        index=pd.DatetimeIndex([_chart_time_to_timestamp(candle.time) for candle in candles]),
    )
    candle_frame = candle_frame.sort_index()
    if candle_frame.index.has_duplicates:
        raise ApiError(422, "duplicate_candle_time", "Candle times must be unique")
    return candle_frame


# --------------------------------------------------------------------------------------
# Computation
# --------------------------------------------------------------------------------------


def _spec_identifier(spec: IndicatorSpec) -> str:
    if spec.id:
        return spec.id
    param_suffix = "_".join(str(value) for value in spec.params.values())
    return f"{spec.name}_{param_suffix}" if param_suffix else spec.name


def _resolve_definition(spec: IndicatorSpec) -> _IndicatorDefinition:
    definition = indicator_registry().get(spec.name.lower())
    if definition is None:
        raise ApiError(422, "unknown_indicator", f"Indicator '{spec.name}' is not supported")
    unknown_params = sorted(set(spec.params) - set(definition.tunable_params))
    if unknown_params:
        raise ApiError(
            422,
            "unknown_indicator_param",
            f"Unsupported parameter(s) for '{definition.name}': {', '.join(unknown_params)}",
            details={"allowed": definition.tunable_params},
        )
    return definition


def run_indicator(candle_frame: pd.DataFrame, spec: IndicatorSpec) -> pd.DataFrame:
    """Run one indicator and always return a DataFrame of output columns."""
    definition = _resolve_definition(spec)
    input_arguments: dict[str, pd.Series] = {}
    for input_param in definition.input_params:
        column_name = OHLCV_INPUT_COLUMNS[input_param]
        input_series = candle_frame[column_name]
        if column_name == "volume" and input_series.isna().any():
            raise ApiError(
                422,
                "volume_required",
                f"Indicator '{definition.name}' needs volume on every candle",
            )
        input_arguments[input_param] = input_series

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            raw_output = definition.function(**input_arguments, **spec.params)
    except Exception as indicator_error:
        raise ApiError(
            422,
            "indicator_failed",
            f"Indicator '{definition.name}' failed: {indicator_error}",
        ) from indicator_error

    if isinstance(raw_output, tuple):  # e.g. ichimoku returns (visible, forward-projected)
        raw_output = raw_output[0]
    if raw_output is None:
        return pd.DataFrame(index=candle_frame.index)
    if isinstance(raw_output, pd.Series):
        return raw_output.to_frame(name=raw_output.name or _spec_identifier(spec).upper())
    return raw_output


def series_to_points(values: pd.Series, chart_times: list[ChartTime]) -> list[LinePoint]:
    points: list[LinePoint] = []
    for chart_time, value in zip(chart_times, values.to_numpy(dtype=float), strict=True):
        if math.isfinite(value):
            points.append(LinePoint(time=chart_time, value=round(float(value), 8)))
    return points


def _series_style(indicator_name: str, column_key: str) -> SeriesStyle:
    if column_key.startswith(HISTOGRAM_COLUMN_PREFIXES) or indicator_name == "ao":
        return SeriesStyle.HISTOGRAM
    return SeriesStyle.LINE


def compute_indicator_result(candle_frame: pd.DataFrame, spec: IndicatorSpec) -> IndicatorResult:
    definition = _resolve_definition(spec)
    output_frame = run_indicator(candle_frame, spec)
    chart_times: list[ChartTime] = candle_frame["chart_time"].tolist()
    aligned_output = output_frame.reindex(candle_frame.index)
    series = [
        ChartSeries(
            key=str(column_key),
            style=_series_style(definition.name, str(column_key)),
            data=series_to_points(aligned_output[column_key], chart_times),
        )
        for column_key in aligned_output.columns
        if pd.api.types.is_numeric_dtype(aligned_output[column_key])
    ]
    return IndicatorResult(
        id=_spec_identifier(spec),
        name=definition.name,
        params=dict(spec.params),
        pane=definition.pane,
        series=series,
        reference_lines=REFERENCE_LINES.get(definition.name, []),
    )


# --------------------------------------------------------------------------------------
# Strategy summary
# --------------------------------------------------------------------------------------


def _last_finite(values: pd.Series | None) -> float | None:
    if values is None:
        return None
    finite_values = values.replace([np.inf, -np.inf], np.nan).dropna()
    return None if finite_values.empty else float(finite_values.iloc[-1])


def _column_starting_with(frame: pd.DataFrame, prefix: str) -> pd.Series | None:
    for column_name in frame.columns:
        if str(column_name).startswith(prefix):
            return frame[column_name]
    return None


def _ema_stack_signal(
    fast: float | None, medium: float | None, slow: float | None
) -> StrategySignal:
    if fast is None or medium is None or slow is None:
        return StrategySignal(name="ema_stack", bias=SignalBias.NEUTRAL, detail="Insufficient data")
    if fast > medium > slow:
        return StrategySignal(
            name="ema_stack", bias=SignalBias.BULLISH, detail="EMA 9 > 21 > 50 (bullish stack)"
        )
    if fast < medium < slow:
        return StrategySignal(
            name="ema_stack", bias=SignalBias.BEARISH, detail="EMA 9 < 21 < 50 (bearish stack)"
        )
    return StrategySignal(name="ema_stack", bias=SignalBias.NEUTRAL, detail="EMAs are tangled")


def _trend_filter_signal(last_close: float, ema_200: float | None) -> StrategySignal:
    if ema_200 is None:
        return StrategySignal(
            name="trend_filter", bias=SignalBias.NEUTRAL, detail="Fewer than 200 bars for EMA 200"
        )
    if last_close > ema_200:
        return StrategySignal(
            name="trend_filter", bias=SignalBias.BULLISH, detail="Close above EMA 200"
        )
    return StrategySignal(
        name="trend_filter", bias=SignalBias.BEARISH, detail="Close below EMA 200"
    )


def _rsi_signal(rsi_value: float | None) -> StrategySignal:
    if rsi_value is None:
        return StrategySignal(name="rsi", bias=SignalBias.NEUTRAL, detail="Insufficient data")
    rounded_rsi = round(rsi_value, 1)
    # Extremes are cautions, not counter-trend votes: strong trends live at RSI > 70 / < 30.
    if rsi_value >= RSI_OVERBOUGHT:
        return StrategySignal(
            name="rsi",
            bias=SignalBias.NEUTRAL,
            detail=f"RSI {rounded_rsi} overbought (strong momentum, pullback risk)",
        )
    if rsi_value <= RSI_OVERSOLD:
        return StrategySignal(
            name="rsi",
            bias=SignalBias.NEUTRAL,
            detail=f"RSI {rounded_rsi} oversold (weak momentum, bounce risk)",
        )
    if rsi_value > 50:
        return StrategySignal(
            name="rsi", bias=SignalBias.BULLISH, detail=f"RSI {rounded_rsi} above 50"
        )
    if rsi_value < 50:
        return StrategySignal(
            name="rsi", bias=SignalBias.BEARISH, detail=f"RSI {rounded_rsi} below 50"
        )
    return StrategySignal(name="rsi", bias=SignalBias.NEUTRAL, detail="RSI at 50")


def _macd_signal(macd_frame: pd.DataFrame) -> StrategySignal:
    macd_line = _column_starting_with(macd_frame, "MACD_")
    signal_line = _column_starting_with(macd_frame, "MACDs_")
    if macd_line is None or signal_line is None:
        return StrategySignal(name="macd", bias=SignalBias.NEUTRAL, detail="Insufficient data")
    spread = (macd_line - signal_line).dropna()
    if spread.empty:
        return StrategySignal(name="macd", bias=SignalBias.NEUTRAL, detail="Insufficient data")
    recent_spread = spread.iloc[-(RECENT_CROSS_LOOKBACK_BARS + 1) :]
    crossed_recently = bool((np.sign(recent_spread).diff().fillna(0) != 0).any())
    cross_note = " (fresh cross)" if crossed_recently else ""
    if spread.iloc[-1] > 0:
        return StrategySignal(
            name="macd", bias=SignalBias.BULLISH, detail=f"MACD above signal{cross_note}"
        )
    if spread.iloc[-1] < 0:
        return StrategySignal(
            name="macd", bias=SignalBias.BEARISH, detail=f"MACD below signal{cross_note}"
        )
    return StrategySignal(name="macd", bias=SignalBias.NEUTRAL, detail="MACD on signal line")


def _bollinger_signal(last_close: float, bbands_frame: pd.DataFrame) -> StrategySignal:
    upper_band = _last_finite(_column_starting_with(bbands_frame, "BBU_"))
    lower_band = _last_finite(_column_starting_with(bbands_frame, "BBL_"))
    if upper_band is None or lower_band is None:
        return StrategySignal(name="bollinger", bias=SignalBias.NEUTRAL, detail="Insufficient data")
    if last_close > upper_band:
        return StrategySignal(
            name="bollinger", bias=SignalBias.NEUTRAL, detail="Close above upper band (extended)"
        )
    if last_close < lower_band:
        return StrategySignal(
            name="bollinger", bias=SignalBias.NEUTRAL, detail="Close below lower band (stretched)"
        )
    band_width = upper_band - lower_band
    percent_b = 0.5 if band_width == 0 else (last_close - lower_band) / band_width
    return StrategySignal(
        name="bollinger",
        bias=SignalBias.NEUTRAL,
        detail=f"Inside bands (%B {percent_b:.2f})",
    )


def summarize_core_strategy(candle_frame: pd.DataFrame) -> StrategySummary:
    """Score the Maison core strategy (EMA stack, EMA 200 filter, RSI, MACD, Bollinger)."""
    close_prices = candle_frame["close"]
    last_close = float(close_prices.iloc[-1])
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        ema_values = {
            length: _last_finite(ta.ema(close_prices, length=length)) for length in (9, 21, 50, 200)
        }
        rsi_value = _last_finite(ta.rsi(close_prices, length=14))
        macd_frame = ta.macd(close_prices, fast=12, slow=26, signal=9)
        bbands_frame = ta.bbands(close_prices, length=20, std=2.0)

    signals = [
        _ema_stack_signal(ema_values[9], ema_values[21], ema_values[50]),
        _trend_filter_signal(last_close, ema_values[200]),
        _rsi_signal(rsi_value),
        _macd_signal(macd_frame if macd_frame is not None else pd.DataFrame()),
        _bollinger_signal(last_close, bbands_frame if bbands_frame is not None else pd.DataFrame()),
    ]
    bias_points = {SignalBias.BULLISH: 1, SignalBias.BEARISH: -1, SignalBias.NEUTRAL: 0}
    score = sum(bias_points[signal.bias] for signal in signals)
    if score >= BIAS_SCORE_THRESHOLD:
        overall_bias = SignalBias.BULLISH
    elif score <= -BIAS_SCORE_THRESHOLD:
        overall_bias = SignalBias.BEARISH
    else:
        overall_bias = SignalBias.NEUTRAL
    return StrategySummary(
        bias=overall_bias,
        score=score,
        signals=signals,
        last_close=last_close,
        last_time=candle_frame["chart_time"].iloc[-1],
    )


# --------------------------------------------------------------------------------------
# Public operations
# --------------------------------------------------------------------------------------


def _check_candle_limit(candles: list[Candle], max_candles: int) -> None:
    if len(candles) > max_candles:
        raise ApiError(413, "too_many_candles", f"At most {max_candles} candles per request")


def compute_indicators(
    compute_request: IndicatorComputeRequest, max_candles: int, max_indicators: int
) -> IndicatorComputeResponse:
    _check_candle_limit(compute_request.candles, max_candles)
    requested_specs = list(compute_request.indicators)
    if compute_request.strategy is not None:
        requested_specs.extend(STRATEGY_PRESETS[compute_request.strategy])
    if not requested_specs:
        raise ApiError(422, "no_indicators", "Provide `indicators` and/or a `strategy` preset")
    if len(requested_specs) > max_indicators:
        raise ApiError(
            422, "too_many_indicators", f"At most {max_indicators} indicators per request"
        )

    candle_frame = build_candle_frame(compute_request.candles)
    indicator_results = [compute_indicator_result(candle_frame, spec) for spec in requested_specs]
    chart_times: list[ChartTime] = candle_frame["chart_time"].tolist()

    candlestick_points = None
    volume_points = None
    if compute_request.include_candles:
        candlestick_points = [
            CandlestickPoint(
                time=chart_time, open=open_price, high=high_price, low=low_price, close=close_price
            )
            for chart_time, open_price, high_price, low_price, close_price in zip(
                chart_times,
                candle_frame["open"],
                candle_frame["high"],
                candle_frame["low"],
                candle_frame["close"],
                strict=True,
            )
        ]
        if not candle_frame["volume"].isna().any():
            volume_points = series_to_points(candle_frame["volume"], chart_times)

    summary = (
        summarize_core_strategy(candle_frame)
        if compute_request.strategy == StrategyPreset.MAISON_CORE
        else None
    )
    return IndicatorComputeResponse(
        candles=candlestick_points,
        volume=volume_points,
        indicators=indicator_results,
        summary=summary,
    )


def scan_timeframes(
    scan_request: MultiTimeframeScanRequest, max_candles: int
) -> MultiTimeframeScanResponse:
    timeframe_results: list[TimeframeScanResult] = []
    for timeframe_label, candles in scan_request.timeframes.items():
        _check_candle_limit(candles, max_candles)
        if len(candles) < 2:
            raise ApiError(
                422, "not_enough_candles", f"Timeframe '{timeframe_label}' needs >= 2 candles"
            )
        candle_frame = build_candle_frame(candles)
        timeframe_results.append(
            TimeframeScanResult(
                timeframe=timeframe_label, summary=summarize_core_strategy(candle_frame)
            )
        )

    total_timeframes = len(timeframe_results)
    bullish_count = sum(result.summary.bias == SignalBias.BULLISH for result in timeframe_results)
    bearish_count = sum(result.summary.bias == SignalBias.BEARISH for result in timeframe_results)
    if bullish_count * 2 > total_timeframes:
        confluence_bias, aligned_count = SignalBias.BULLISH, bullish_count
    elif bearish_count * 2 > total_timeframes:
        confluence_bias, aligned_count = SignalBias.BEARISH, bearish_count
    else:
        confluence_bias = SignalBias.NEUTRAL
        aligned_count = total_timeframes - bullish_count - bearish_count
    return MultiTimeframeScanResponse(
        results=timeframe_results,
        confluence_bias=confluence_bias,
        aligned_timeframes=aligned_count,
        total_timeframes=total_timeframes,
    )


# --------------------------------------------------------------------------------------
# HTTP routes (sync handlers run in FastAPI's threadpool; pandas work is CPU-bound)
# --------------------------------------------------------------------------------------


def build_router(auth_dependency: Callable[..., Any]) -> APIRouter:
    router = APIRouter(
        prefix="/api/v1/indicators", tags=["indicators"], dependencies=[Depends(auth_dependency)]
    )

    @router.get("", response_model=IndicatorCatalogResponse)
    def list_indicators() -> IndicatorCatalogResponse:
        return build_catalog()

    @router.post("/compute", response_model=IndicatorComputeResponse)
    def compute(
        compute_request: IndicatorComputeRequest, request: Request
    ) -> IndicatorComputeResponse:
        settings = request.app.state.settings
        return compute_indicators(compute_request, settings.max_candles, settings.max_indicators)

    @router.post("/scan", response_model=MultiTimeframeScanResponse)
    def scan(
        scan_request: MultiTimeframeScanRequest, request: Request
    ) -> MultiTimeframeScanResponse:
        return scan_timeframes(scan_request, request.app.state.settings.max_candles)

    return router
