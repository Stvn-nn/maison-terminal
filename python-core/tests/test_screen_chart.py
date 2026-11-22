from __future__ import annotations

import cv2
import numpy as np
from fastapi.testclient import TestClient

from schemas import PixelRect
from screen_chart import locate_chart_region, read_candles
from tests.chart_rendering import (
    CANDLE_SPACING_PX,
    DARK_THEME,
    IMAGE_HEIGHT,
    IMAGE_WIDTH,
    PRICE_AXIS_X,
    TIME_AXIS_Y,
    render_chart,
    sine_closes,
)

# TEST FIXTURES ONLY: synthetic price paths rendered as broker-style charts.
SWINGING_CLOSES = sine_closes(
    bar_count=80, base_price=100, amplitude=8, period_bars=24, drift_per_bar=0.05
)
DESKTOP_WIDTH, DESKTOP_HEIGHT = 2000, 1200


def plot_area(chart_image: np.ndarray) -> np.ndarray:
    return chart_image[:TIME_AXIS_Y, :PRICE_AXIS_X]


def drawn_bar_count(close_prices: list[float], first_candle_x: int = 4) -> int:
    return sum(
        1
        for bar_index in range(len(close_prices))
        if first_candle_x + bar_index * CANDLE_SPACING_PX + 5 < PRICE_AXIS_X
    )


def place_on_desktop(chart_image: np.ndarray, left: int, top: int) -> np.ndarray:
    desktop = np.full((DESKTOP_HEIGHT, DESKTOP_WIDTH, 3), (30, 30, 30), dtype=np.uint8)
    desktop[top : top + IMAGE_HEIGHT, left : left + IMAGE_WIDTH] = chart_image
    return desktop


class TestReadCandles:
    def test_reads_every_candle_with_direction(self) -> None:
        candles = read_candles(plot_area(render_chart(SWINGING_CLOSES, draw_price_line=False)))
        expected_count = drawn_bar_count(SWINGING_CLOSES)
        assert len(candles) == expected_count

        open_prices = [SWINGING_CLOSES[0], *SWINGING_CLOSES[:-1]]
        expected_up = [
            close >= open_price
            for open_price, close in zip(open_prices, SWINGING_CLOSES, strict=False)
        ][:expected_count]
        read_up = [candle.close >= candle.open for candle in candles]
        matching_directions = sum(
            expected == read for expected, read in zip(expected_up, read_up, strict=True)
        )
        assert matching_directions >= expected_count - 2  # dojis can read either way

    def test_relative_scale_preserves_shape(self) -> None:
        candles = read_candles(plot_area(render_chart(SWINGING_CLOSES, draw_price_line=False)))
        assert all(100 <= candle.low <= candle.high <= 200 for candle in candles)
        highest_read = max(range(len(candles)), key=lambda index: candles[index].high)
        drawn_highs = [
            max(SWINGING_CLOSES[max(0, index - 1)], SWINGING_CLOSES[index])
            for index in range(len(candles))
        ]
        highest_drawn = max(range(len(candles)), key=lambda index: drawn_highs[index])
        assert abs(highest_read - highest_drawn) <= 1
        assert [candle.time for candle in candles] == sorted(candle.time for candle in candles)

    def test_ignores_volume_bars(self) -> None:
        chart_image = render_chart(SWINGING_CLOSES, draw_price_line=False)
        for bar_index in range(drawn_bar_count(SWINGING_CLOSES)):
            center_x = 4 + bar_index * CANDLE_SPACING_PX
            bar_height = 10 + (bar_index * 7) % 30
            color = DARK_THEME.bullish if bar_index % 2 else DARK_THEME.bearish
            cv2.rectangle(
                chart_image,
                (center_x - 2, TIME_AXIS_Y - 2 - bar_height),
                (center_x + 2, TIME_AXIS_Y - 2),
                color,
                -1,
            )
        candles = read_candles(plot_area(chart_image))
        assert abs(len(candles) - drawn_bar_count(SWINGING_CLOSES)) <= 2

    def test_blank_plot_has_no_candles(self) -> None:
        assert read_candles(np.full((300, 500, 3), 20, dtype=np.uint8)) == []


class TestLocateChartRegion:
    def test_finds_the_chart_and_covers_it(self) -> None:
        desktop = place_on_desktop(render_chart(SWINGING_CLOSES), left=900, top=250)
        candidate = locate_chart_region(desktop, excluded_rects=[])
        assert candidate is not None
        region = candidate.bounds
        assert region.x <= 900 + 8 and region.x + region.width >= 900 + PRICE_AXIS_X - 40
        assert region.y <= 250 + 60 and region.y + region.height >= 250 + TIME_AXIS_Y - 60

    def test_ignores_excluded_windows(self) -> None:
        desktop = place_on_desktop(render_chart(SWINGING_CLOSES), left=1100, top=300)
        own_window = render_chart(sine_closes(80, 50, 4, 16, 0.0))
        desktop[100 : 100 + IMAGE_HEIGHT, 50 : 50 + IMAGE_WIDTH] = own_window
        maison_window = PixelRect(x=50, y=100, width=IMAGE_WIDTH, height=IMAGE_HEIGHT)
        candidate = locate_chart_region(desktop, excluded_rects=[maison_window])
        assert candidate is not None
        assert candidate.bounds.x >= 50 + IMAGE_WIDTH  # never inside the excluded window

    def test_nothing_to_find(self) -> None:
        desktop = np.full((DESKTOP_HEIGHT, DESKTOP_WIDTH, 3), (30, 30, 30), dtype=np.uint8)
        assert locate_chart_region(desktop, excluded_rects=[]) is None


def test_candles_endpoint_reports_unavailable_when_idle(client: TestClient) -> None:
    body = client.get("/api/v1/vision/candles").json()
    assert body == {
        "available": False,
        "source": "screen",
        "scale": "relative",
        "captured_at": None,
        "region": None,
        "candles": [],
        "note": "Chart watch is not running",
    }
