"""Find a broker chart on screen and read its candles from the pixels.

Two pure functions used by the vision service:

``locate_chart_region``
    Scans a full-monitor capture for the largest area of coloured (green/red) candles,
    ignoring excluded rectangles such as the Maison Terminal window, and returns a
    capture region around it (extended left to the chart's border and right to cover
    the price axis).

``read_candles``
    Reads every candle in a plot image: the wick gives high/low, the body and colour give
    open/close. Volume bars (a cluster sharing one baseline near the bottom) are ignored.
    The screen shows shapes, not price labels, so values are on a *relative* scale:
    100 = bottom of the plot, 200 = top. Times are sequential placeholders, one per bar.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

import vision
from schemas import Candle, PixelRect

SCAN_DOWNSCALE = 4  # analyse monitors at 1/4 resolution: fast, and candles survive it
SCAN_MERGE_KERNEL_PX = 9  # (downscaled px) joins neighbouring candles into one chart blob
MIN_CHART_WIDTH_FRACTION = 0.15  # of the monitor
MIN_CHART_HEIGHT_FRACTION = 0.12
MIN_CANDLE_COLUMN_COVERAGE = 0.25  # share of the blob's columns that contain candles
MIN_SCAN_CANDLE_PIXELS = 40
PRICE_AXIS_ALLOWANCE_FRACTION = 0.12  # extend right of the candles to include the axis
VERTICAL_PADDING_FRACTION = 0.10
LEFT_BORDER_SEARCH_FRACTION = 0.6  # look this far left (of chart width) for the border
BORDER_MIN_FILL = 0.85
MIN_REGION_SIZE_PX = 64

SCREEN_TIME_ORIGIN = 1_700_000_000  # placeholder timeline: one bar per minute from here
SCREEN_BAR_SECONDS = 60
RELATIVE_FLOOR = 100.0
RELATIVE_SPAN = 100.0
BODY_SPAN_RATIO = 0.6  # a row is "body" when it spans >= 60% of the candle's width
VOLUME_BASELINE_TOLERANCE_PX = 2
VOLUME_MIN_SHARE = 0.25
VOLUME_BASELINE_MIN_DEPTH = 0.65  # volume baseline sits in the lower part of the plot


@dataclass(frozen=True)
class ChartCandidate:
    bounds: PixelRect  # capture region in the scanned frame's pixel coordinates
    candle_columns: int  # full-resolution columns containing candles (detection strength)


def _overlaps_vertically(rect: PixelRect, top: int, bottom: int) -> bool:
    return rect.y < bottom and rect.y + rect.height > top


def _find_left_border(
    frame: np.ndarray, top: int, bottom: int, start_x: int, stop_x: int
) -> int | None:
    """Nearest neutral vertical line (chart border) left of ``start_x``, if any."""
    if start_x <= stop_x:
        return None
    band = frame[top:bottom, stop_x:start_x]
    background_color = vision.estimate_background_color(band)
    saturation = cv2.cvtColor(band, cv2.COLOR_BGR2HSV)[:, :, 1]
    neutral_foreground = vision.foreground_mask(band, background_color) & (
        saturation < vision.SEPARATOR_MAX_SATURATION
    )
    border_columns = np.flatnonzero(neutral_foreground.mean(axis=0) >= BORDER_MIN_FILL)
    return int(stop_x + border_columns[-1]) if border_columns.size else None


def locate_chart_region(
    frame: np.ndarray, excluded_rects: list[PixelRect]
) -> ChartCandidate | None:
    frame_height, frame_width = frame.shape[:2]
    small_width = max(1, frame_width // SCAN_DOWNSCALE)
    small_height = max(1, frame_height // SCAN_DOWNSCALE)
    small_frame = cv2.resize(frame, (small_width, small_height), interpolation=cv2.INTER_AREA)

    candle_mask = vision._colored_candle_mask(small_frame)
    for excluded in excluded_rects:
        left = max(0, excluded.x // SCAN_DOWNSCALE)
        top = max(0, excluded.y // SCAN_DOWNSCALE)
        right = min(small_width, -(-(excluded.x + excluded.width) // SCAN_DOWNSCALE))
        bottom = min(small_height, -(-(excluded.y + excluded.height) // SCAN_DOWNSCALE))
        if right > left and bottom > top:
            candle_mask[top:bottom, left:right] = False
    candle_mask = vision._remove_lines_and_labels(candle_mask)
    if int(candle_mask.sum()) < MIN_SCAN_CANDLE_PIXELS:
        return None

    merge_kernel = np.ones((SCAN_MERGE_KERNEL_PX, SCAN_MERGE_KERNEL_PX), np.uint8)
    merged = cv2.morphologyEx(candle_mask.astype(np.uint8), cv2.MORPH_CLOSE, merge_kernel)
    component_count, _, component_stats, _ = cv2.connectedComponentsWithStats(
        merged, connectivity=8
    )

    best_blob: tuple[int, int, int, int, int] | None = None
    for component_index in range(1, component_count):
        blob_x, blob_y, blob_width, blob_height = (
            int(value) for value in component_stats[component_index][:4]
        )
        if blob_width < MIN_CHART_WIDTH_FRACTION * small_width:
            continue
        if blob_height < MIN_CHART_HEIGHT_FRACTION * small_height:
            continue
        blob_mask = candle_mask[blob_y : blob_y + blob_height, blob_x : blob_x + blob_width]
        candle_columns = int(blob_mask.any(axis=0).sum())
        if candle_columns < MIN_CANDLE_COLUMN_COVERAGE * blob_width:
            continue
        if best_blob is None or candle_columns > best_blob[0]:
            best_blob = (candle_columns, blob_x, blob_y, blob_width, blob_height)
    if best_blob is None:
        return None

    candle_columns, blob_x, blob_y, blob_width, blob_height = best_blob
    candles_left = blob_x * SCAN_DOWNSCALE
    candles_right = (blob_x + blob_width) * SCAN_DOWNSCALE
    candles_top = blob_y * SCAN_DOWNSCALE
    candles_bottom = (blob_y + blob_height) * SCAN_DOWNSCALE
    candles_width = candles_right - candles_left
    candles_height = candles_bottom - candles_top

    region_top = max(0, int(candles_top - VERTICAL_PADDING_FRACTION * candles_height))
    region_bottom = min(
        frame_height, int(candles_bottom + VERTICAL_PADDING_FRACTION * candles_height)
    )

    # Never extend into an excluded window that sits beside the chart.
    left_limit, right_limit = 0, frame_width
    for excluded in excluded_rects:
        if not _overlaps_vertically(excluded, region_top, region_bottom):
            continue
        if excluded.x + excluded.width <= candles_left:
            left_limit = max(left_limit, excluded.x + excluded.width)
        elif excluded.x >= candles_right:
            right_limit = min(right_limit, excluded.x)

    search_stop = max(left_limit, int(candles_left - LEFT_BORDER_SEARCH_FRACTION * candles_width))
    left_border = _find_left_border(frame, region_top, region_bottom, candles_left, search_stop)
    region_left = left_border if left_border is not None else search_stop
    region_right = min(
        right_limit, int(candles_right + PRICE_AXIS_ALLOWANCE_FRACTION * candles_width)
    )

    region_width = region_right - region_left
    region_height = region_bottom - region_top
    if region_width < MIN_REGION_SIZE_PX or region_height < MIN_REGION_SIZE_PX:
        return None
    return ChartCandidate(
        bounds=PixelRect(x=region_left, y=region_top, width=region_width, height=region_height),
        candle_columns=candle_columns * SCAN_DOWNSCALE,
    )


@dataclass(frozen=True)
class _CandleShape:
    center_x: float
    top_y: int
    body_top_y: int
    body_bottom_y: int
    bottom_y: int
    is_up: bool
    pixel_count: int


def _shapes_from_component(
    component: np.ndarray, origin_x: int, origin_y: int, is_up: bool, slice_count: int
) -> list[_CandleShape]:
    component_width = component.shape[1]
    slice_edges = np.linspace(0, component_width, slice_count + 1).astype(int)
    shapes: list[_CandleShape] = []
    for slice_index in range(slice_count):
        slice_start, slice_stop = slice_edges[slice_index], slice_edges[slice_index + 1]
        candle_pixels = component[:, slice_start:slice_stop]
        if candle_pixels.size == 0 or not candle_pixels.any():
            continue
        rows_with_pixels = candle_pixels.any(axis=1)
        occupied_rows = np.flatnonzero(rows_with_pixels)
        slice_width = candle_pixels.shape[1]
        first_column = candle_pixels.argmax(axis=1)
        last_column = slice_width - 1 - candle_pixels[:, ::-1].argmax(axis=1)
        row_span = np.where(rows_with_pixels, last_column - first_column + 1, 0)
        if slice_width >= 3:
            body_rows = np.flatnonzero(row_span >= max(2, BODY_SPAN_RATIO * slice_width))
        else:
            body_rows = occupied_rows  # too thin to tell body from wick
        if body_rows.size == 0:
            body_rows = occupied_rows
        shapes.append(
            _CandleShape(
                center_x=origin_x + (slice_start + slice_stop) / 2,
                top_y=origin_y + int(occupied_rows[0]),
                body_top_y=origin_y + int(body_rows[0]),
                body_bottom_y=origin_y + int(body_rows[-1]),
                bottom_y=origin_y + int(occupied_rows[-1]),
                is_up=is_up,
                pixel_count=int(candle_pixels.sum()),
            )
        )
    return shapes


def _drop_volume_bars(shapes: list[_CandleShape], plot_height: int) -> list[_CandleShape]:
    """Volume bars share one baseline near the bottom of the plot; candles do not."""
    if len(shapes) < 10:
        return shapes
    bottoms = np.array([shape.bottom_y for shape in shapes])
    baseline = int(np.bincount(bottoms).argmax())
    on_baseline = np.abs(bottoms - baseline) <= VOLUME_BASELINE_TOLERANCE_PX
    is_volume_cluster = baseline >= VOLUME_BASELINE_MIN_DEPTH * plot_height and (
        on_baseline.sum() >= max(8, VOLUME_MIN_SHARE * len(shapes))
    )
    if not is_volume_cluster:
        return shapes
    return [shape for shape, is_volume in zip(shapes, on_baseline, strict=True) if not is_volume]


GLYPH_MAX_HEIGHT_FRACTION = 0.04  # text is short relative to the plot...
GLYPH_MIN_ASPECT = 0.4  # ...and not as thin as a candle (width >= 0.4 x height)

MONOCHROME_NOTE = (
    "Single-colour candles: hollow bodies read as up and filled bodies as down; bars too "
    "thin to show a body use their midpoint as the close."
)


def read_candles_with_mode(plot_image: np.ndarray) -> tuple[list[Candle], str]:
    """Read coloured candles, falling back to single-colour candles. Returns (candles, mode)."""
    coloured_candles = read_candles(plot_image)
    monochrome_candles = read_monochrome_candles(plot_image)
    # Buttons and labels can look like a few coloured candles on a single-colour chart, so
    # prefer the reading that finds clearly more candles.
    if len(monochrome_candles) > 2 * len(coloured_candles):
        return monochrome_candles, "monochrome"
    return coloured_candles, "colour"


def read_monochrome_candles(plot_image: np.ndarray) -> list[Candle]:
    """Candles drawn in one colour (e.g. black on a light theme)."""
    plot_height = plot_image.shape[0]
    if plot_height < 8:
        return []
    background_color = vision.estimate_background_color(plot_image)
    candle_mask = vision._remove_lines_and_labels(
        vision.foreground_mask(plot_image, background_color)
    )
    # Drop text glyphs (price-axis numbers, legends): short blobs that are not thin and tall.
    component_count, component_labels, component_stats, _ = cv2.connectedComponentsWithStats(
        candle_mask.astype(np.uint8), connectivity=8
    )
    component_widths = component_stats[:, cv2.CC_STAT_WIDTH]
    component_heights = component_stats[:, cv2.CC_STAT_HEIGHT]
    is_glyph = (component_heights <= GLYPH_MAX_HEIGHT_FRACTION * plot_height) & (
        component_widths >= GLYPH_MIN_ASPECT * component_heights
    )
    is_glyph[0] = False
    if component_count > 1 and is_glyph.any():
        candle_mask = candle_mask & ~is_glyph[component_labels]
    occupied_columns = np.flatnonzero(candle_mask.any(axis=0))
    if occupied_columns.size < 10:
        return []
    gap_positions = np.flatnonzero(np.diff(occupied_columns) > 1)
    run_starts = np.r_[occupied_columns[0], occupied_columns[gap_positions + 1]]
    run_ends = np.r_[occupied_columns[gap_positions], occupied_columns[-1]]
    typical_width = max(1, int(np.median(run_ends - run_starts + 1)))

    def to_relative_value(pixel_y: int) -> float:
        height_share = (plot_height - 1 - pixel_y) / (plot_height - 1)
        return round(RELATIVE_FLOOR + height_share * RELATIVE_SPAN, 4)

    candles: list[Candle] = []
    for run_start, run_end in zip(run_starts, run_ends, strict=True):
        run_width = run_end - run_start + 1
        is_merged = run_width > 2.5 * typical_width
        slice_count = max(1, round(run_width / typical_width)) if is_merged else 1
        slice_edges = np.linspace(run_start, run_end + 1, slice_count + 1).astype(int)
        for slice_start, slice_stop in zip(slice_edges[:-1], slice_edges[1:], strict=True):
            bar_pixels = candle_mask[:, slice_start:slice_stop]
            occupied_rows = np.flatnonzero(bar_pixels.any(axis=1))
            if occupied_rows.size < 2:
                continue
            high_value = to_relative_value(int(occupied_rows[0]))
            low_value = to_relative_value(int(occupied_rows[-1]))
            bar_width = bar_pixels.shape[1]
            row_span = bar_pixels.sum(axis=1)
            body_rows = (
                np.flatnonzero(row_span >= max(2, BODY_SPAN_RATIO * bar_width))
                if bar_width >= 3
                else np.array([], dtype=int)
            )
            if body_rows.size >= 2:
                body_top, body_bottom = int(body_rows[0]), int(body_rows[-1])
                interior = bar_pixels[body_top + 1 : body_bottom, bar_width // 2]
                is_hollow = interior.size > 0 and interior.mean() < 0.5
                body_high, body_low = to_relative_value(body_top), to_relative_value(body_bottom)
                open_value, close_value = (
                    (body_low, body_high) if is_hollow else (body_high, body_low)
                )
            else:
                midpoint = round((high_value + low_value) / 2, 4)
                open_value = close_value = midpoint
            candles.append(
                Candle(
                    time=SCREEN_TIME_ORIGIN + len(candles) * SCREEN_BAR_SECONDS,
                    open=open_value,
                    high=high_value,
                    low=low_value,
                    close=close_value,
                )
            )
    return candles


def read_candles(plot_image: np.ndarray) -> list[Candle]:
    plot_height = plot_image.shape[0]
    if plot_height < 8:
        return []
    hsv_image = cv2.cvtColor(plot_image, cv2.COLOR_BGR2HSV)
    hue, saturation, brightness = cv2.split(hsv_image)
    vivid = (saturation >= vision.MIN_SATURATION) & (brightness >= vision.MIN_BRIGHTNESS)
    is_green_hue = (hue >= vision.GREEN_HUE_RANGE[0]) & (hue <= vision.GREEN_HUE_RANGE[1])
    is_red_hue = (hue <= vision.RED_HUE_LOW_MAX) | (hue >= vision.RED_HUE_HIGH_MIN)
    up_mask = vision._remove_lines_and_labels(vivid & is_green_hue)
    down_mask = vision._remove_lines_and_labels(vivid & is_red_hue)

    components: list[tuple[np.ndarray, int, int, int, bool]] = []
    for is_up, color_mask in ((True, up_mask), (False, down_mask)):
        component_count, component_labels, component_stats, _ = cv2.connectedComponentsWithStats(
            color_mask.astype(np.uint8), connectivity=8
        )
        for component_index in range(1, component_count):
            box_x, box_y, box_width, box_height, box_area = (
                int(value) for value in component_stats[component_index]
            )
            if box_height < 2 or box_area < 3:
                continue
            component = (
                component_labels[box_y : box_y + box_height, box_x : box_x + box_width]
                == component_index
            )
            components.append((component, box_x, box_y, box_width, is_up))
    if not components:
        return []

    typical_width = max(1, int(np.median([component[3] for component in components])))
    shapes: list[_CandleShape] = []
    for component, box_x, box_y, box_width, is_up in components:
        # Candles touching each other (zoomed-out charts) merge; split them by typical width.
        is_merged = box_width > 2.5 * typical_width
        slice_count = max(1, round(box_width / typical_width)) if is_merged else 1
        shapes.extend(_shapes_from_component(component, box_x, box_y, is_up, slice_count))
    shapes = _drop_volume_bars(shapes, plot_height)

    shapes.sort(key=lambda shape: shape.center_x)
    minimum_spacing = max(1.0, 0.6 * typical_width)
    distinct_shapes: list[_CandleShape] = []
    for shape in shapes:
        if distinct_shapes and shape.center_x - distinct_shapes[-1].center_x < minimum_spacing:
            if shape.pixel_count > distinct_shapes[-1].pixel_count:
                distinct_shapes[-1] = shape
            continue
        distinct_shapes.append(shape)

    def to_relative_value(pixel_y: int) -> float:
        height_share = (plot_height - 1 - pixel_y) / (plot_height - 1)
        return round(RELATIVE_FLOOR + height_share * RELATIVE_SPAN, 4)

    candles: list[Candle] = []
    for bar_index, shape in enumerate(distinct_shapes):
        body_high = to_relative_value(shape.body_top_y)
        body_low = to_relative_value(shape.body_bottom_y)
        open_value, close_value = (body_low, body_high) if shape.is_up else (body_high, body_low)
        candles.append(
            Candle(
                time=SCREEN_TIME_ORIGIN + bar_index * SCREEN_BAR_SECONDS,
                open=open_value,
                high=to_relative_value(shape.top_y),
                low=to_relative_value(shape.bottom_y),
                close=close_value,
            )
        )
    return candles
