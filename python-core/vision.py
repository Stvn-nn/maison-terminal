"""Screen vision: capture a broker chart region and detect truncated swing structure.

Pipeline (all in pixel space; no price OCR):

1. **Capture** the configured screen region with ``mss`` (physical pixels).
2. **Plot bounds**: estimate the background colour, then look for long axis separator
   lines to isolate the plot area from the price and time axes.
3. **Candle mask**: HSV thresholds for green/red candles, or a foreground mask for
   monochrome themes. Grid lines, price lines and axis labels are removed.
4. **Price envelope**: for each pixel column, the topmost (high) and bottommost (low)
   candle pixel.
5. **Swing structure**: confirmed swing highs/lows need a full look-back window on both
   sides and a minimum prominence.
6. **Truncation rules**: when candles run all the way to the left edge of the plot *and*
   either the major high/low sits in the left-edge zone, or fewer than two confirmed swing
   highs or lows are visible, the trader needs to scroll back.

A :class:`BacktrackDebouncer` turns per-frame verdicts into ``BACKTRACK_REQUIRED`` /
``BACKTRACK_CLEARED`` transitions, so the UI is not spammed by flicker.

Privacy: frames live only in memory and are never written to disk or sent anywhere.
Only the derived :class:`schemas.VisionAnalysis` leaves this module.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import logging
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import cv2
import mss
import numpy as np
from fastapi import APIRouter, Depends, Request

from config import Settings
from errors import ApiError
from schemas import (
    BACKTRACK_CLEARED_MESSAGE,
    BACKTRACK_REQUIRED_MESSAGE,
    CandleColorProfile,
    MonitorInfo,
    PixelRect,
    ScreenRegion,
    SwingPoint,
    VisionAnalysis,
    VisionCheckRequest,
    VisionConfig,
    VisionState,
    VisionStatus,
    WsEventType,
)
from ws import WebSocketBroadcaster

logger = logging.getLogger("maison.vision")

# --- Tunables -------------------------------------------------------------------------
BACKGROUND_COLOR_DISTANCE = 40.0  # BGR distance that counts as "not background"
AXIS_LINE_MIN_FILL = 0.90  # a separator line covers >= 90% of the image span
SEPARATOR_MAX_SATURATION = 40  # axis separators are grey; coloured lines are price lines
AXIS_SEARCH_FRACTION_RIGHT = 0.40  # price axis separator searched in the right 40%
AXIS_SEARCH_FRACTION_EDGE = 0.15  # left/top separators searched in the outer 15%
AXIS_SEARCH_FRACTION_BOTTOM = 0.30
GRIDLINE_ROW_FILL = 0.45  # rows this full of mask pixels are grid / price lines
GRIDLINE_COLUMN_FILL = 0.85  # columns this full are crosshair / separator lines
MIN_SATURATION = 60
MIN_BRIGHTNESS = 60
GREEN_HUE_RANGE = (35, 100)  # OpenCV hue 0-180; covers pure green through teal
RED_HUE_LOW_MAX = 12
RED_HUE_HIGH_MIN = 165
AUTO_COLOR_MIN_FRACTION = 0.002
MIN_SPECK_AREA = 3
LABEL_MIN_WIDTH_FRACTION = 0.03
LABEL_MAX_HEIGHT_FRACTION = 0.05
LABEL_MIN_ASPECT = 2.5
MIN_DATA_COVERAGE = 0.15
MIN_VALID_COLUMNS = 20
SWING_WINDOW_FRACTION = 0.02
MIN_SWING_WINDOW_PX = 4
SWING_PROMINENCE_FRACTION = 0.04
MIN_SWING_PROMINENCE_PX = 3
MIN_STRUCTURE_RANGE_FRACTION = 0.10
MIN_LEFT_MARGIN_PX = 6
MAX_DECODED_IMAGE_PIXELS = 40_000_000
ERROR_BACKOFF_SECONDS = 2.0

REASON_NO_CHART = "no_chart_detected"
REASON_HISTORY_START = "history_start_visible"
REASON_MAJOR_HIGH_AT_EDGE = "major_high_at_left_edge"
REASON_MAJOR_LOW_AT_EDGE = "major_low_at_left_edge"
REASON_INSUFFICIENT_SWINGS = "insufficient_swing_structure"
REASON_FLAT_STRUCTURE = "structure_range_too_small"


# --------------------------------------------------------------------------------------
# Capture
# --------------------------------------------------------------------------------------

_thread_local_state = threading.local()


def _screen_grabber() -> mss.MSS:
    """One mss instance per thread: mss handles are not thread-safe."""
    grabber = getattr(_thread_local_state, "screen_grabber", None)
    if grabber is None:
        grabber = mss.MSS()
        _thread_local_state.screen_grabber = grabber
    return grabber


def capture_region(region: ScreenRegion) -> np.ndarray:
    """Grab a screen rectangle (physical pixels) and return a BGR image."""
    screenshot = _screen_grabber().grab(
        {"left": region.left, "top": region.top, "width": region.width, "height": region.height}
    )
    bgra_pixels = np.asarray(screenshot)
    return cv2.cvtColor(bgra_pixels, cv2.COLOR_BGRA2BGR)


def list_monitors() -> list[MonitorInfo]:
    monitors = _screen_grabber().monitors
    return [
        MonitorInfo(
            index=monitor_index,
            left=monitor["left"],
            top=monitor["top"],
            width=monitor["width"],
            height=monitor["height"],
            is_virtual_desktop=monitor_index == 0,
        )
        for monitor_index, monitor in enumerate(monitors)
    ]


def decode_image(image_base64: str) -> np.ndarray:
    """Decode a base64 PNG/JPEG (optionally a data: URL) into a BGR image."""
    _, _, encoded_payload = image_base64.rpartition(",")
    try:
        image_bytes = base64.b64decode(encoded_payload, validate=True)
    except (binascii.Error, ValueError) as decode_error:
        raise ApiError(422, "invalid_image", "image_base64 is not valid base64") from decode_error
    decoded_image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
    if decoded_image is None:
        raise ApiError(422, "invalid_image", "image_base64 is not a PNG or JPEG image")
    image_height, image_width = decoded_image.shape[:2]
    if image_height * image_width > MAX_DECODED_IMAGE_PIXELS:
        raise ApiError(413, "image_too_large", "Image exceeds 40 megapixels")
    return decoded_image


# --------------------------------------------------------------------------------------
# Image analysis
# --------------------------------------------------------------------------------------


def estimate_background_color(image: np.ndarray) -> np.ndarray:
    """Most common colour after coarse quantisation (robust to candles and grid lines)."""
    quantised = (image // 16).reshape(-1, 3).astype(np.int32)
    bin_codes = quantised[:, 0] * 256 + quantised[:, 1] * 16 + quantised[:, 2]
    dominant_code = np.bincount(bin_codes).argmax()
    dominant_pixels = image.reshape(-1, 3)[bin_codes == dominant_code]
    return dominant_pixels.mean(axis=0)


def foreground_mask(image: np.ndarray, background_color: np.ndarray) -> np.ndarray:
    color_distance = np.linalg.norm(image.astype(np.float32) - background_color, axis=2)
    return color_distance > BACKGROUND_COLOR_DISTANCE


def _line_positions(fill_ratios: np.ndarray, search_start: int, search_stop: int) -> list[int]:
    return [
        position
        for position in range(max(0, search_start), min(len(fill_ratios), search_stop))
        if fill_ratios[position] >= AXIS_LINE_MIN_FILL
    ]


def detect_plot_bounds(image: np.ndarray, background_color: np.ndarray) -> PixelRect:
    """Find the plot area inside axis separator lines; falls back to the full image.

    Only neutral (grey) pixels count towards a separator, so a coloured last-price line
    spanning the plot is never mistaken for an axis border.
    """
    image_height, image_width = image.shape[:2]
    saturation = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)[:, :, 1]
    neutral_foreground = foreground_mask(image, background_color) & (
        saturation < SEPARATOR_MAX_SATURATION
    )
    column_fill = neutral_foreground.mean(axis=0)
    row_fill = neutral_foreground.mean(axis=1)

    plot_left, plot_right = 0, image_width
    plot_top, plot_bottom = 0, image_height

    right_separators = _line_positions(
        column_fill, int(image_width * (1 - AXIS_SEARCH_FRACTION_RIGHT)), image_width
    )
    if right_separators:
        plot_right = right_separators[0]
    left_separators = _line_positions(column_fill, 0, int(image_width * AXIS_SEARCH_FRACTION_EDGE))
    if left_separators:
        plot_left = left_separators[-1] + 1
    bottom_separators = _line_positions(
        row_fill, int(image_height * (1 - AXIS_SEARCH_FRACTION_BOTTOM)), image_height
    )
    if bottom_separators:
        plot_bottom = bottom_separators[0]
    top_separators = _line_positions(row_fill, 0, int(image_height * AXIS_SEARCH_FRACTION_EDGE))
    if top_separators:
        plot_top = top_separators[-1] + 1

    return PixelRect(
        x=plot_left,
        y=plot_top,
        width=max(1, plot_right - plot_left),
        height=max(1, plot_bottom - plot_top),
    )


def _colored_candle_mask(plot_image: np.ndarray) -> np.ndarray:
    hsv_image = cv2.cvtColor(plot_image, cv2.COLOR_BGR2HSV)
    hue, saturation, brightness = cv2.split(hsv_image)
    vivid = (saturation >= MIN_SATURATION) & (brightness >= MIN_BRIGHTNESS)
    is_green = (hue >= GREEN_HUE_RANGE[0]) & (hue <= GREEN_HUE_RANGE[1])
    is_red = (hue <= RED_HUE_LOW_MAX) | (hue >= RED_HUE_HIGH_MIN)
    return vivid & (is_green | is_red)


def resolve_color_profile(
    plot_image: np.ndarray, requested_profile: CandleColorProfile
) -> CandleColorProfile:
    if requested_profile != CandleColorProfile.AUTO:
        return requested_profile
    colored_fraction = float(_colored_candle_mask(plot_image).mean())
    if colored_fraction >= AUTO_COLOR_MIN_FRACTION:
        return CandleColorProfile.GREEN_RED
    return CandleColorProfile.MONOCHROME


def _remove_lines_and_labels(candle_mask: np.ndarray) -> np.ndarray:
    plot_height, plot_width = candle_mask.shape
    cleaned_mask = candle_mask.copy()
    cleaned_mask[cleaned_mask.mean(axis=1) >= GRIDLINE_ROW_FILL, :] = False
    cleaned_mask[:, cleaned_mask.mean(axis=0) >= GRIDLINE_COLUMN_FILL] = False

    component_count, component_labels, component_stats, _ = cv2.connectedComponentsWithStats(
        cleaned_mask.astype(np.uint8), connectivity=8
    )
    for component_index in range(1, component_count):
        component_width = component_stats[component_index, cv2.CC_STAT_WIDTH]
        component_height = component_stats[component_index, cv2.CC_STAT_HEIGHT]
        component_area = component_stats[component_index, cv2.CC_STAT_AREA]
        is_speck = component_area < MIN_SPECK_AREA
        is_label_or_line = (
            component_width >= max(12, LABEL_MIN_WIDTH_FRACTION * plot_width)
            and component_height <= LABEL_MAX_HEIGHT_FRACTION * plot_height
            and component_width >= LABEL_MIN_ASPECT * component_height
        )
        if is_speck or is_label_or_line:
            cleaned_mask[component_labels == component_index] = False
    return cleaned_mask


def build_candle_mask(
    plot_image: np.ndarray, background_color: np.ndarray, color_profile: CandleColorProfile
) -> np.ndarray:
    if color_profile == CandleColorProfile.GREEN_RED:
        raw_mask = _colored_candle_mask(plot_image)
    else:
        raw_mask = foreground_mask(plot_image, background_color)
    return _remove_lines_and_labels(raw_mask)


@dataclass(frozen=True)
class PriceEnvelope:
    """Per-column candle extent in plot pixels. ``NaN`` where a column has no candles."""

    high_y: np.ndarray  # smaller y == higher price
    low_y: np.ndarray

    @property
    def valid_columns(self) -> np.ndarray:
        return np.flatnonzero(~np.isnan(self.high_y))


def extract_price_envelope(candle_mask: np.ndarray) -> PriceEnvelope:
    plot_height = candle_mask.shape[0]
    column_has_candle = candle_mask.any(axis=0)
    topmost_row = candle_mask.argmax(axis=0).astype(float)
    bottommost_row = (plot_height - 1 - candle_mask[::-1].argmax(axis=0)).astype(float)
    topmost_row[~column_has_candle] = np.nan
    bottommost_row[~column_has_candle] = np.nan
    return PriceEnvelope(high_y=topmost_row, low_y=bottommost_row)


def _retracement_before_exceeded(
    side_values: np.ndarray, pivot_value: float, more_extreme: Callable[..., np.ndarray]
) -> float:
    """Largest move away from the pivot before a more extreme bar appears on one side.

    ``side_values`` is ordered walking *away* from the pivot. Returns 0 when there is no
    visible data on that side.
    """
    exceeding_positions = np.flatnonzero(more_extreme(side_values, pivot_value))
    reachable_values = (
        side_values[: exceeding_positions[0]] if exceeding_positions.size else side_values
    )
    finite_values = reachable_values[np.isfinite(reachable_values)]
    if finite_values.size == 0:
        return 0.0
    return float(np.max(np.abs(finite_values - pivot_value)))


def find_confirmed_swings(
    envelope: PriceEnvelope, window_px: int, prominence_px: float
) -> list[SwingPoint]:
    """Confirmed swing highs/lows using topographic prominence.

    A candidate swing high is the highest point within ``window_px`` on both sides. It is
    *confirmed* only if, walking outward on each side until a higher high appears (or the
    visible data ends), price retraced at least ``prominence_px``. A high whose left-side
    retracement would lie beyond the first visible candle is therefore unconfirmed, which
    is exactly the "structure fell off the left edge" situation. Swing lows mirror this.
    """
    valid_columns = envelope.valid_columns
    if valid_columns.size == 0:
        return []
    first_column, last_column = int(valid_columns[0]), int(valid_columns[-1])
    swing_points: list[SwingPoint] = []
    last_high_x = -window_px * 2
    last_low_x = -window_px * 2

    for column in (int(valid_column) for valid_column in valid_columns):
        window_slice = slice(max(first_column, column - window_px), column + window_px + 1)

        high_y = envelope.high_y[column]
        if high_y == np.nanmin(envelope.high_y[window_slice]) and column - last_high_x > window_px:
            # Smaller y is a higher price, so "more extreme" means a smaller y value.
            left_drop = _retracement_before_exceeded(
                envelope.high_y[first_column:column][::-1], high_y, np.less
            )
            right_drop = _retracement_before_exceeded(
                envelope.high_y[column + 1 : last_column + 1], high_y, np.less
            )
            if min(left_drop, right_drop) >= prominence_px:
                swing_points.append(SwingPoint(x=column, y=int(high_y), kind="high"))
                last_high_x = column

        low_y = envelope.low_y[column]
        if low_y == np.nanmax(envelope.low_y[window_slice]) and column - last_low_x > window_px:
            left_rise = _retracement_before_exceeded(
                envelope.low_y[first_column:column][::-1], low_y, np.greater
            )
            right_rise = _retracement_before_exceeded(
                envelope.low_y[column + 1 : last_column + 1], low_y, np.greater
            )
            if min(left_rise, right_rise) >= prominence_px:
                swing_points.append(SwingPoint(x=column, y=int(low_y), kind="low"))
                last_low_x = column
    return swing_points


def _offset_swings(swing_points: list[SwingPoint], plot_bounds: PixelRect) -> list[SwingPoint]:
    return [
        SwingPoint(x=point.x + plot_bounds.x, y=point.y + plot_bounds.y, kind=point.kind)
        for point in swing_points
    ]


def analyze_chart_image(
    image: np.ndarray,
    color_profile: CandleColorProfile = CandleColorProfile.AUTO,
    left_margin_pct: float = 0.05,
    plot_bounds_override: PixelRect | None = None,
) -> VisionAnalysis:
    """Run the full pipeline on one BGR frame and return a truncation verdict."""
    image_height, image_width = image.shape[:2]
    captured_at = datetime.now(UTC)
    background_color = estimate_background_color(image)
    plot_bounds = plot_bounds_override or detect_plot_bounds(image, background_color)
    plot_image = image[
        plot_bounds.y : plot_bounds.y + plot_bounds.height,
        plot_bounds.x : plot_bounds.x + plot_bounds.width,
    ]
    plot_height, plot_width = plot_image.shape[:2]

    effective_profile = resolve_color_profile(plot_image, color_profile)
    candle_mask = build_candle_mask(plot_image, background_color, effective_profile)
    envelope = extract_price_envelope(candle_mask)
    valid_columns = envelope.valid_columns
    data_coverage = valid_columns.size / max(1, plot_width)

    def build_result(
        truncated: bool,
        reasons: list[str],
        confidence: float,
        swing_points: list[SwingPoint] | None = None,
        data_left_x: int | None = None,
    ) -> VisionAnalysis:
        return VisionAnalysis(
            captured_at=captured_at,
            image_width=image_width,
            image_height=image_height,
            chart_bounds=plot_bounds,
            data_left_x=data_left_x,
            data_coverage=round(data_coverage, 4),
            swing_points=_offset_swings(swing_points or [], plot_bounds),
            structure_truncated=truncated,
            reasons=reasons,
            confidence=round(min(1.0, max(0.0, confidence)), 3),
        )

    if valid_columns.size < MIN_VALID_COLUMNS or data_coverage < MIN_DATA_COVERAGE:
        return build_result(False, [REASON_NO_CHART], confidence=0.0)

    first_data_column = int(valid_columns[0])
    data_left_x = first_data_column + plot_bounds.x
    left_margin_px = max(MIN_LEFT_MARGIN_PX, int(left_margin_pct * plot_width))
    window_px = max(MIN_SWING_WINDOW_PX, int(SWING_WINDOW_FRACTION * plot_width))
    prominence_px = max(MIN_SWING_PROMINENCE_PX, SWING_PROMINENCE_FRACTION * plot_height)
    swing_points = find_confirmed_swings(envelope, window_px, prominence_px)
    coverage_confidence = 0.4 + 0.6 * min(1.0, data_coverage / 0.6)

    if first_data_column > left_margin_px:
        return build_result(
            False, [REASON_HISTORY_START], coverage_confidence, swing_points, data_left_x
        )

    structure_range = float(np.nanmax(envelope.low_y) - np.nanmin(envelope.high_y))
    if structure_range < MIN_STRUCTURE_RANGE_FRACTION * plot_height:
        return build_result(
            False, [REASON_FLAT_STRUCTURE], coverage_confidence * 0.5, swing_points, data_left_x
        )

    edge_zone_end = first_data_column + left_margin_px
    reasons: list[str] = []
    if int(np.nanargmin(envelope.high_y)) <= edge_zone_end:
        reasons.append(REASON_MAJOR_HIGH_AT_EDGE)
    if int(np.nanargmax(envelope.low_y)) <= edge_zone_end:
        reasons.append(REASON_MAJOR_LOW_AT_EDGE)
    confirmed_high_count = sum(point.kind == "high" for point in swing_points)
    confirmed_low_count = sum(point.kind == "low" for point in swing_points)
    if confirmed_high_count < 2 or confirmed_low_count < 2:
        reasons.append(REASON_INSUFFICIENT_SWINGS)

    major_extreme_cut_off = any(
        reason in (REASON_MAJOR_HIGH_AT_EDGE, REASON_MAJOR_LOW_AT_EDGE) for reason in reasons
    )
    confidence = coverage_confidence if major_extreme_cut_off else coverage_confidence * 0.7
    return build_result(bool(reasons), reasons, confidence, swing_points, data_left_x)


# --------------------------------------------------------------------------------------
# Debouncing
# --------------------------------------------------------------------------------------


class BacktrackDebouncer:
    """Convert noisy per-frame verdicts into alert transitions.

    * ``confirm_frames`` consecutive truncated frames raise the alert.
    * ``confirm_frames`` consecutive clear frames lower it.
    * A raised alert is not re-sent within ``cooldown_seconds`` of the previous one.
    * Frames with no chart (window switched, chart hidden) change nothing.
    """

    def __init__(
        self,
        confirm_frames: int,
        cooldown_seconds: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._confirm_frames = max(1, confirm_frames)
        self._cooldown_seconds = cooldown_seconds
        self._clock = clock
        self._truncated_streak = 0
        self._clear_streak = 0
        self._alert_active = False
        self._last_alert_at: float | None = None
        self._chart_visible = False

    @property
    def state(self) -> VisionState:
        if self._alert_active:
            return VisionState.BACKTRACK_REQUIRED
        return VisionState.STRUCTURE_VISIBLE if self._chart_visible else VisionState.NO_CHART

    def reset(self) -> None:
        self._truncated_streak = 0
        self._clear_streak = 0
        self._alert_active = False
        self._chart_visible = False

    def update(self, analysis: VisionAnalysis) -> WsEventType | None:
        if REASON_NO_CHART in analysis.reasons:
            self._chart_visible = False
            self._truncated_streak = 0
            self._clear_streak = 0
            return None
        self._chart_visible = True

        if analysis.structure_truncated:
            self._truncated_streak += 1
            self._clear_streak = 0
            cooldown_elapsed = (
                self._last_alert_at is None
                or self._clock() - self._last_alert_at >= self._cooldown_seconds
            )
            if (
                not self._alert_active
                and self._truncated_streak >= self._confirm_frames
                and cooldown_elapsed
            ):
                self._alert_active = True
                self._last_alert_at = self._clock()
                return WsEventType.BACKTRACK_REQUIRED
            return None

        self._clear_streak += 1
        self._truncated_streak = 0
        if self._alert_active and self._clear_streak >= self._confirm_frames:
            self._alert_active = False
            return WsEventType.BACKTRACK_CLEARED
        return None


def backtrack_event_data(analysis: VisionAnalysis) -> dict[str, Any]:
    return {
        "reasons": analysis.reasons,
        "confidence": analysis.confidence,
        "data_left_x": analysis.data_left_x,
        "chart_bounds": None
        if analysis.chart_bounds is None
        else analysis.chart_bounds.model_dump(),
    }


# --------------------------------------------------------------------------------------
# Service (background capture loop)
# --------------------------------------------------------------------------------------


class VisionService:
    def __init__(self, settings: Settings, broadcaster: WebSocketBroadcaster) -> None:
        self._settings = settings
        self._broadcaster = broadcaster
        # Single worker thread so the thread-local mss handle is reused across frames.
        self._worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="vision")
        self._debouncer = BacktrackDebouncer(
            settings.vision_confirm_frames, settings.vision_cooldown_seconds
        )
        self._config: VisionConfig | None = None
        self._loop_task: asyncio.Task[None] | None = None
        self._last_analysis: VisionAnalysis | None = None
        self._last_error: str | None = None

    @property
    def is_running(self) -> bool:
        return self._loop_task is not None and not self._loop_task.done()

    def status(self) -> VisionStatus:
        return VisionStatus(
            running=self.is_running,
            state=self._debouncer.state if self.is_running else VisionState.IDLE,
            config=self._config,
            last_analysis=self._last_analysis,
            last_error=self._last_error,
        )

    def configure(self, config: VisionConfig) -> None:
        self._config = config
        self._debouncer.reset()

    def _margin_pct(self, config: VisionConfig | None) -> float:
        if config is not None and config.left_margin_pct is not None:
            return config.left_margin_pct
        return self._settings.vision_left_margin_pct

    async def _run_in_worker(self, function: Callable[..., Any], *arguments: Any) -> Any:
        event_loop = asyncio.get_running_loop()
        return await event_loop.run_in_executor(self._worker, function, *arguments)

    async def list_monitors(self) -> list[MonitorInfo]:
        return await self._run_in_worker(list_monitors)

    async def check_once(self, check_request: VisionCheckRequest) -> VisionAnalysis:
        """Stateless one-shot analysis: never touches the debouncer or broadcasts."""
        if check_request.image_base64 is not None:
            frame = decode_image(check_request.image_base64)
        elif self._config is not None:
            frame = await self._run_in_worker(capture_region, self._config.region)
        else:
            raise ApiError(
                409, "vision_not_configured", "Send image_base64 or PUT /api/v1/vision/config first"
            )
        color_profile = check_request.color_profile or (
            self._config.color_profile if self._config else CandleColorProfile.AUTO
        )
        plot_bounds = check_request.plot_bounds or (
            self._config.plot_bounds if self._config else None
        )
        return await self._run_in_worker(
            analyze_chart_image, frame, color_profile, self._margin_pct(self._config), plot_bounds
        )

    async def start(self) -> None:
        if self._config is None:
            raise ApiError(409, "vision_not_configured", "PUT /api/v1/vision/config first")
        if self.is_running:
            return
        self._debouncer.reset()
        self._last_error = None
        self._loop_task = asyncio.create_task(self._capture_loop(), name="vision-loop")
        await self._broadcaster.broadcast(
            WsEventType.VISION_STATUS, "Chart watch started", {"running": True}
        )

    async def stop(self) -> None:
        if self._loop_task is None:
            return
        self._loop_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._loop_task
        self._loop_task = None
        await self._broadcaster.broadcast(
            WsEventType.VISION_STATUS, "Chart watch stopped", {"running": False}
        )

    async def shutdown(self) -> None:
        await self.stop()
        self._worker.shutdown(wait=False, cancel_futures=True)

    async def process_frame(self, frame: np.ndarray, config: VisionConfig) -> VisionAnalysis:
        """Analyse a frame, update the debouncer and broadcast any transition."""
        analysis: VisionAnalysis = await self._run_in_worker(
            analyze_chart_image,
            frame,
            config.color_profile,
            self._margin_pct(config),
            config.plot_bounds,
        )
        self._last_analysis = analysis
        transition = self._debouncer.update(analysis)
        if transition == WsEventType.BACKTRACK_REQUIRED:
            await self._broadcaster.broadcast(
                WsEventType.BACKTRACK_REQUIRED,
                BACKTRACK_REQUIRED_MESSAGE,
                backtrack_event_data(analysis),
            )
        elif transition == WsEventType.BACKTRACK_CLEARED:
            await self._broadcaster.broadcast(
                WsEventType.BACKTRACK_CLEARED,
                BACKTRACK_CLEARED_MESSAGE,
                backtrack_event_data(analysis),
            )
        return analysis

    async def _capture_loop(self) -> None:
        while True:
            config = self._config
            if config is None:
                return
            try:
                frame = await self._run_in_worker(capture_region, config.region)
                await self.process_frame(frame, config)
                if self._last_error is not None:
                    self._last_error = None
                await asyncio.sleep(self._settings.vision_interval_seconds)
            except asyncio.CancelledError:
                raise
            except Exception as frame_error:  # noqa: BLE001 - keep the watch loop alive
                error_text = f"{type(frame_error).__name__}: {frame_error}"
                if error_text != self._last_error:
                    logger.warning("Vision frame failed: %s", error_text)
                    await self._broadcaster.broadcast(
                        WsEventType.VISION_STATUS,
                        "Chart watch error",
                        {"running": True, "error": error_text},
                    )
                self._last_error = error_text
                await asyncio.sleep(ERROR_BACKOFF_SECONDS)


# --------------------------------------------------------------------------------------
# HTTP routes
# --------------------------------------------------------------------------------------


def _vision_service(request: Request) -> VisionService:
    return request.app.state.vision_service


def build_router(auth_dependency: Callable[..., Any]) -> APIRouter:
    router = APIRouter(
        prefix="/api/v1/vision", tags=["vision"], dependencies=[Depends(auth_dependency)]
    )

    @router.get("/monitors", response_model=list[MonitorInfo])
    async def get_monitors(request: Request) -> list[MonitorInfo]:
        return await _vision_service(request).list_monitors()

    @router.get("/status", response_model=VisionStatus)
    async def get_status(request: Request) -> VisionStatus:
        return _vision_service(request).status()

    @router.put("/config", response_model=VisionStatus)
    async def put_config(config: VisionConfig, request: Request) -> VisionStatus:
        vision_service = _vision_service(request)
        vision_service.configure(config)
        return vision_service.status()

    @router.post("/start", response_model=VisionStatus)
    async def start_watch(request: Request) -> VisionStatus:
        vision_service = _vision_service(request)
        await vision_service.start()
        return vision_service.status()

    @router.post("/stop", response_model=VisionStatus)
    async def stop_watch(request: Request) -> VisionStatus:
        vision_service = _vision_service(request)
        await vision_service.stop()
        return vision_service.status()

    @router.post("/check", response_model=VisionAnalysis)
    async def check(check_request: VisionCheckRequest, request: Request) -> VisionAnalysis:
        return await _vision_service(request).check_once(check_request)

    return router
