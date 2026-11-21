"""Render synthetic broker-style candlestick charts for vision tests."""

from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np

IMAGE_WIDTH = 800
IMAGE_HEIGHT = 500
PRICE_AXIS_X = 720  # vertical separator between plot and price axis
TIME_AXIS_Y = 460  # horizontal separator between plot and time axis
CANDLE_SPACING_PX = 8
CANDLE_BODY_WIDTH_PX = 5
VERTICAL_PADDING_PX = 30


@dataclass(frozen=True)
class ChartTheme:
    background: tuple[int, int, int]
    bullish: tuple[int, int, int]
    bearish: tuple[int, int, int]
    axis_line: tuple[int, int, int]
    faint_grid: tuple[int, int, int]


DARK_THEME = ChartTheme(
    background=(24, 20, 20),
    bullish=(154, 166, 38),  # TradingView teal #26a69a in BGR
    bearish=(80, 83, 239),  # TradingView red #ef5350 in BGR
    axis_line=(120, 120, 120),
    faint_grid=(40, 36, 36),
)
LIGHT_THEME = ChartTheme(
    background=(255, 255, 255),
    bullish=(30, 30, 30),
    bearish=(30, 30, 30),
    axis_line=(150, 150, 150),
    faint_grid=(235, 235, 235),
)


def sine_closes(
    bar_count: int,
    base_price: float,
    amplitude: float,
    period_bars: float,
    drift_per_bar: float,
    phase_bars: float = 0.0,
) -> list[float]:
    return [
        base_price
        + drift_per_bar * bar_index
        + amplitude * math.sin(2 * math.pi * (bar_index + phase_bars) / period_bars)
        for bar_index in range(bar_count)
    ]


def render_chart(
    close_prices: list[float],
    theme: ChartTheme = DARK_THEME,
    first_candle_x: int = 4,
    draw_price_line: bool = True,
) -> np.ndarray:
    """Draw candles (open = previous close) inside a plot with price/time axes."""
    image = np.full((IMAGE_HEIGHT, IMAGE_WIDTH, 3), theme.background, dtype=np.uint8)

    for grid_y in range(40, TIME_AXIS_Y, 80):
        cv2.line(image, (0, grid_y), (PRICE_AXIS_X - 1, grid_y), theme.faint_grid, 1)
    cv2.line(image, (PRICE_AXIS_X, 0), (PRICE_AXIS_X, IMAGE_HEIGHT - 1), theme.axis_line, 1)
    cv2.line(image, (0, TIME_AXIS_Y), (IMAGE_WIDTH - 1, TIME_AXIS_Y), theme.axis_line, 1)

    open_prices = [close_prices[0], *close_prices[:-1]]
    high_prices = [max(o, c) + 0.6 for o, c in zip(open_prices, close_prices, strict=True)]
    low_prices = [min(o, c) - 0.6 for o, c in zip(open_prices, close_prices, strict=True)]
    price_ceiling, price_floor = max(high_prices), min(low_prices)
    drawable_height = TIME_AXIS_Y - 2 * VERTICAL_PADDING_PX

    def price_to_y(price: float) -> int:
        relative_position = (price_ceiling - price) / (price_ceiling - price_floor)
        return int(VERTICAL_PADDING_PX + relative_position * drawable_height)

    for bar_index, (open_price, close_price, high_price, low_price) in enumerate(
        zip(open_prices, close_prices, high_prices, low_prices, strict=True)
    ):
        candle_center_x = first_candle_x + bar_index * CANDLE_SPACING_PX
        if candle_center_x + CANDLE_BODY_WIDTH_PX >= PRICE_AXIS_X:
            break
        candle_color = theme.bullish if close_price >= open_price else theme.bearish
        cv2.line(
            image,
            (candle_center_x, price_to_y(high_price)),
            (candle_center_x, price_to_y(low_price)),
            candle_color,
            1,
        )
        body_top = min(price_to_y(open_price), price_to_y(close_price))
        body_bottom = max(price_to_y(open_price), price_to_y(close_price), body_top + 1)
        cv2.rectangle(
            image,
            (candle_center_x - CANDLE_BODY_WIDTH_PX // 2, body_top),
            (candle_center_x + CANDLE_BODY_WIDTH_PX // 2, body_bottom),
            candle_color,
            -1,
        )

    if draw_price_line:
        last_close_y = price_to_y(close_prices[-1])
        cv2.line(image, (0, last_close_y), (PRICE_AXIS_X - 1, last_close_y), theme.bearish, 1)
        cv2.rectangle(
            image,
            (PRICE_AXIS_X + 2, last_close_y - 9),
            (IMAGE_WIDTH - 4, last_close_y + 9),
            theme.bearish,
            -1,
        )
    return image
