"""Pydantic models that define every REST and WebSocket contract of the sidecar.

This module is the single source of truth for the frontend: ``docs/contract/``
is generated from it and ``docs/API_CONTRACT.md`` documents it.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# --------------------------------------------------------------------------------------
# Shared primitives
# --------------------------------------------------------------------------------------

# Lightweight Charts accepts either a UTC unix timestamp in seconds ("UTCTimestamp")
# or a business-day string "YYYY-MM-DD". We accept and echo back the same form.
ChartTime = int | str


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Candle(StrictModel):
    time: ChartTime = Field(description="Unix seconds (UTC) or 'YYYY-MM-DD'.")
    open: float = Field(gt=0)
    high: float = Field(gt=0)
    low: float = Field(gt=0)
    close: float = Field(gt=0)
    volume: float | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def check_price_range(self) -> Candle:
        if self.low > self.high:
            raise ValueError("low must be <= high")
        if not (self.low <= self.open <= self.high and self.low <= self.close <= self.high):
            raise ValueError("open and close must lie within [low, high]")
        return self


class FinnhubKeyRequest(StrictModel):
    api_key: str = Field(
        min_length=8,
        max_length=80,
        pattern=r"^[A-Za-z0-9_\-]+$",
        description="The user's own Finnhub API key (stored only in the local .env file).",
    )


class FinnhubKeyStatus(BaseModel):
    """Whether a Finnhub key is set. The key itself is never returned."""

    configured: bool
    calendar_available: bool | None = Field(
        default=None,
        description="False when the key's plan has no economic calendar; None if unknown.",
    )


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    service: str = "maison-terminal-core"
    version: str
    server_time: datetime
    finnhub_configured: bool
    vision_running: bool
    websocket_clients: int


# --------------------------------------------------------------------------------------
# Sizing
# --------------------------------------------------------------------------------------


class SizingMode(StrEnum):
    FIXED_CASH = "fixed_cash"
    EQUITY_PCT = "equity_pct"
    RISK_TO_STOP = "risk_to_stop"


class TradeSide(StrEnum):
    LONG = "long"
    SHORT = "short"


class SizingRequest(StrictModel):
    mode: SizingMode
    entry_price: float = Field(gt=0)
    stop_price: float | None = Field(default=None, gt=0)
    side: TradeSide | None = Field(
        default=None, description="Inferred from stop_price vs entry_price when omitted."
    )
    account_equity: float | None = Field(default=None, gt=0)
    cash_amount: float | None = Field(
        default=None, gt=0, description="fixed_cash: notional to deploy."
    )
    equity_pct: float | None = Field(
        default=None, gt=0, le=100, description="equity_pct: percent of equity to deploy."
    )
    risk_cash: float | None = Field(
        default=None, gt=0, description="risk_to_stop: dollars to lose if the stop is hit."
    )
    risk_pct: float | None = Field(
        default=None, gt=0, le=100, description="risk_to_stop: percent of equity to risk."
    )
    max_notional: float | None = Field(
        default=None, gt=0, description="Optional buying-power cap on position notional."
    )
    allow_fractional: bool = False
    lot_size: float | None = Field(
        default=None,
        gt=0,
        description="Round shares down to this step. Defaults to 1, or 0.0001 when fractional.",
    )
    target_r_multiples: list[float] = Field(default_factory=lambda: [1.0, 2.0, 3.0])

    @field_validator("target_r_multiples")
    @classmethod
    def check_r_multiples(cls, r_multiples: list[float]) -> list[float]:
        if len(r_multiples) > 10:
            raise ValueError("at most 10 target R multiples")
        if any(multiple <= 0 for multiple in r_multiples):
            raise ValueError("target R multiples must be positive")
        return r_multiples


class PriceTarget(BaseModel):
    r_multiple: float
    price: float


class SizingResponse(BaseModel):
    mode: SizingMode
    side: TradeSide | None
    shares: float
    entry_price: float
    stop_price: float | None
    notional: float
    stop_distance: float | None
    stop_distance_pct: float | None
    risk_amount: float | None = Field(description="Dollars lost if the stop is hit.")
    risk_pct_of_equity: float | None
    notional_pct_of_equity: float | None
    capped_by_max_notional: bool
    targets: list[PriceTarget]
    warnings: list[str]


# --------------------------------------------------------------------------------------
# Indicators
# --------------------------------------------------------------------------------------

IndicatorParamValue = int | float | str | bool


class IndicatorSpec(StrictModel):
    name: str = Field(description="pandas-ta indicator name, e.g. 'ema', 'rsi', 'macd'.")
    params: dict[str, IndicatorParamValue] = Field(default_factory=dict)
    id: str | None = Field(default=None, description="Client label echoed back.")


class StrategyPreset(StrEnum):
    MAISON_CORE = "maison_core"


class IndicatorComputeRequest(StrictModel):
    candles: list[Candle] = Field(min_length=2)
    indicators: list[IndicatorSpec] = Field(default_factory=list)
    strategy: StrategyPreset | None = Field(
        default=None, description="Adds the preset's indicators to `indicators`."
    )
    include_candles: bool = True


class ChartPane(StrEnum):
    PRICE = "price"
    OSCILLATOR = "oscillator"


class SeriesStyle(StrEnum):
    LINE = "line"
    HISTOGRAM = "histogram"


class LinePoint(BaseModel):
    """Lightweight Charts `LineData` / `HistogramData` point."""

    time: ChartTime
    value: float


class ChartSeries(BaseModel):
    key: str = Field(description="Column name, e.g. 'EMA_21', 'MACDh_12_26_9'.")
    style: SeriesStyle
    data: list[LinePoint]


class IndicatorResult(BaseModel):
    id: str
    name: str
    params: dict[str, IndicatorParamValue]
    pane: ChartPane
    series: list[ChartSeries]
    reference_lines: list[float] = Field(
        default_factory=list, description="Horizontal guides, e.g. RSI 30/70."
    )


class CandlestickPoint(BaseModel):
    """Lightweight Charts `CandlestickData` point."""

    time: ChartTime
    open: float
    high: float
    low: float
    close: float


class SignalBias(StrEnum):
    BULLISH = "bullish"
    BEARISH = "bearish"
    NEUTRAL = "neutral"


class StrategySignal(BaseModel):
    name: str
    bias: SignalBias
    detail: str


class StrategySummary(BaseModel):
    bias: SignalBias
    score: int = Field(description="Sum of +1 bullish / -1 bearish signals.")
    signals: list[StrategySignal]
    last_close: float
    last_time: ChartTime


class IndicatorComputeResponse(BaseModel):
    candles: list[CandlestickPoint] | None
    volume: list[LinePoint] | None
    indicators: list[IndicatorResult]
    summary: StrategySummary | None = Field(
        description="Present when the core EMA/RSI/MACD/BBands columns were computed."
    )


class IndicatorCatalogEntry(BaseModel):
    name: str
    category: str
    pane: ChartPane
    inputs: list[str]
    params: list[str]


class IndicatorCatalogResponse(BaseModel):
    count: int
    indicators: list[IndicatorCatalogEntry]


class MultiTimeframeScanRequest(StrictModel):
    timeframes: dict[str, list[Candle]] = Field(
        description="Map of timeframe label (e.g. '15m', '1h', '1D') to candles."
    )
    strategy: StrategyPreset = StrategyPreset.MAISON_CORE

    @field_validator("timeframes")
    @classmethod
    def check_timeframes(cls, timeframes: dict[str, list[Candle]]) -> dict[str, list[Candle]]:
        if not 1 <= len(timeframes) <= 8:
            raise ValueError("provide between 1 and 8 timeframes")
        return timeframes


class TimeframeScanResult(BaseModel):
    timeframe: str
    summary: StrategySummary


class MultiTimeframeScanResponse(BaseModel):
    results: list[TimeframeScanResult]
    confluence_bias: SignalBias
    aligned_timeframes: int
    total_timeframes: int


# --------------------------------------------------------------------------------------
# Vision
# --------------------------------------------------------------------------------------


class ScreenRegion(StrictModel):
    """Absolute virtual-desktop rectangle in physical pixels (may be negative)."""

    left: int
    top: int
    width: int = Field(ge=64, le=8192)
    height: int = Field(ge=64, le=8192)


class PixelRect(BaseModel):
    x: int
    y: int
    width: int
    height: int


class CandleColorProfile(StrEnum):
    AUTO = "auto"
    GREEN_RED = "green_red"
    MONOCHROME = "monochrome"


class VisionConfig(StrictModel):
    region: ScreenRegion
    color_profile: CandleColorProfile = CandleColorProfile.AUTO
    left_margin_pct: float | None = Field(default=None, gt=0, le=0.3)
    plot_bounds: PixelRect | None = Field(
        default=None, description="Manual plot-area override, relative to the region."
    )


class SwingPoint(BaseModel):
    x: int
    y: int
    kind: Literal["high", "low"]


class VisionState(StrEnum):
    IDLE = "idle"
    NO_CHART = "no_chart"
    STRUCTURE_VISIBLE = "structure_visible"
    BACKTRACK_REQUIRED = "backtrack_required"


class VisionAnalysis(BaseModel):
    captured_at: datetime
    image_width: int
    image_height: int
    chart_bounds: PixelRect | None
    data_left_x: int | None
    data_coverage: float = Field(description="Fraction of plot columns containing candles.")
    swing_points: list[SwingPoint]
    structure_truncated: bool
    reasons: list[str]
    confidence: float = Field(ge=0, le=1)


class VisionCheckRequest(StrictModel):
    image_base64: str | None = Field(
        default=None,
        description="Optional PNG/JPEG to analyse instead of capturing the configured region.",
        max_length=12_000_000,
    )
    color_profile: CandleColorProfile | None = None
    plot_bounds: PixelRect | None = None


class VisionStatus(BaseModel):
    running: bool
    state: VisionState
    config: VisionConfig | None
    last_analysis: VisionAnalysis | None
    last_error: str | None
    chart_in_view: bool = Field(
        default=True,
        description="False while the followed chart window is minimised, covered or not a chart.",
    )


class MonitorInfo(BaseModel):
    index: int
    left: int
    top: int
    width: int
    height: int
    is_virtual_desktop: bool


class ExcludedRegion(StrictModel):
    """A screen rectangle the scan must ignore (e.g. the Maison Terminal window itself)."""

    left: int
    top: int
    width: int = Field(ge=1, le=16384)
    height: int = Field(ge=1, le=16384)


class ChartScanRequest(StrictModel):
    exclude_regions: list[ExcludedRegion] = Field(default_factory=list, max_length=8)
    start_watch: bool = Field(default=True, description="Configure and start the watch if found.")


class ChartScanResponse(BaseModel):
    found: bool
    region: ScreenRegion | None
    monitor_index: int | None
    candle_columns: int = Field(description="Screen columns containing candles in the region.")
    message: str
    status: VisionStatus


class ScreenCandlesResponse(BaseModel):
    """Candles read from the watched screen region (shape only, no price labels)."""

    available: bool
    source: Literal["screen"] = "screen"
    scale: Literal["relative"] = Field(
        default="relative",
        description="Prices are 100 (bottom of the plot) to 200 (top), not market prices.",
    )
    in_view: bool = Field(
        default=True,
        description="False while the chart is out of view; candles are then the last reading.",
    )
    captured_at: datetime | None
    region: ScreenRegion | None
    candles: list[Candle]
    note: str | None = None
    source_window_title: str | None = Field(
        default=None, description="Title of the window showing the watched chart."
    )
    symbol: str | None = Field(default=None, description="Instrument parsed from that title.")
    title_last_price: str | None = Field(
        default=None, description="Last price as displayed in the title (text, not a number)."
    )
    title_change: str | None = Field(default=None, description="Change as displayed, e.g. '−3.7%'.")
    title_direction: Literal["up", "down"] | None = None


# --------------------------------------------------------------------------------------
# Macro & news
# --------------------------------------------------------------------------------------


class ImpactLevel(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class EconomicEvent(BaseModel):
    id: str = Field(description="Stable hash of country + event + time.")
    time: datetime = Field(description="Release time, UTC.")
    country: str
    event: str
    impact: ImpactLevel
    actual: float | None
    estimate: float | None
    previous: float | None
    unit: str | None


class EconomicCalendarResponse(BaseModel):
    from_date: str
    to_date: str
    count: int
    events: list[EconomicEvent]
    cached: bool


class SentimentLabel(StrEnum):
    BULLISH = "bullish"
    BEARISH = "bearish"
    NEUTRAL = "neutral"


class HeadlineSentiment(BaseModel):
    score: float = Field(ge=-1, le=1)
    label: SentimentLabel
    source: Literal["lexicon"] = "lexicon"


class NewsItem(BaseModel):
    id: int
    published_at: datetime
    headline: str
    summary: str
    source: str
    url: str
    category: str
    related: list[str]
    image: str | None
    sentiment: HeadlineSentiment


class NewsResponse(BaseModel):
    category: str | None
    symbol: str | None
    count: int
    items: list[NewsItem]
    cached: bool


class SymbolSentimentResponse(BaseModel):
    symbol: str
    source: Literal["finnhub", "lexicon"]
    bullish_pct: float | None
    bearish_pct: float | None
    score: float = Field(ge=-1, le=1)
    label: SentimentLabel
    articles_analysed: int
    note: str | None = None


# --------------------------------------------------------------------------------------
# WebSocket events (server -> client)
# --------------------------------------------------------------------------------------


class WsEventType(StrEnum):
    HELLO = "HELLO"
    HEARTBEAT = "HEARTBEAT"
    PONG = "PONG"
    ERROR = "ERROR"
    BACKTRACK_REQUIRED = "BACKTRACK_REQUIRED"
    BACKTRACK_CLEARED = "BACKTRACK_CLEARED"
    VISION_STATUS = "VISION_STATUS"
    MACRO_EVENT_UPCOMING = "MACRO_EVENT_UPCOMING"
    NEWS_FLASH = "NEWS_FLASH"


BACKTRACK_REQUIRED_MESSAGE = "Historical Context Needed: Please scroll back on your trading chart"
BACKTRACK_CLEARED_MESSAGE = "Chart structure visible"


class WsEvent(BaseModel):
    """Envelope for every server-to-client WebSocket frame.

    ``event`` and ``message`` are always present; ``ts`` and ``data`` are additive.
    """

    event: WsEventType
    message: str
    ts: datetime
    data: dict[str, Any] | None = None


class WsClientMessage(StrictModel):
    """Client-to-server frame. Only ``{"action": "ping"}`` is supported today."""

    action: Literal["ping"]


class HelloEventData(BaseModel):
    version: str


class BacktrackEventData(BaseModel):
    reasons: list[str]
    confidence: float
    data_left_x: int | None
    chart_bounds: PixelRect | None


class VisionStatusEventData(BaseModel):
    running: bool
    error: str | None = None


class MacroEventUpcomingData(BaseModel):
    event: EconomicEvent
    minutes_until: int


class NewsFlashData(BaseModel):
    item: NewsItem


# ``data`` model for each server event; ``None`` means the event carries no data.
WS_EVENT_DATA_MODELS: dict[WsEventType, type[BaseModel] | None] = {
    WsEventType.HELLO: HelloEventData,
    WsEventType.HEARTBEAT: None,
    WsEventType.PONG: None,
    WsEventType.ERROR: None,
    WsEventType.BACKTRACK_REQUIRED: BacktrackEventData,
    WsEventType.BACKTRACK_CLEARED: BacktrackEventData,
    WsEventType.VISION_STATUS: VisionStatusEventData,
    WsEventType.MACRO_EVENT_UPCOMING: MacroEventUpcomingData,
    WsEventType.NEWS_FLASH: NewsFlashData,
}
