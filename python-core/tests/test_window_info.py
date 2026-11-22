from __future__ import annotations

import pytest

from window_info import parse_chart_title


@pytest.mark.parametrize(
    ("window_title", "expected"),
    [
        ("SPX 6,910.39 ▼ −3.7% - Google Chrome", ("SPX", "6,910.39", "−3.7%", "down")),
        ("EURUSD 1.08321 ▲ +0.12% Unnamed - TradingView", ("EURUSD", "1.08321", "+0.12%", "up")),
        ("NASDAQ:AAPL 190.12 ▲ +0.5% - Microsoft Edge", ("AAPL", "190.12", "+0.5%", "up")),
        ("⁨BTCUSD⁩ 97,412 - Brave", ("BTCUSD", "97,412", None, None)),
    ],
)
def test_parses_chart_titles(window_title: str, expected: tuple) -> None:
    chart_title = parse_chart_title(window_title)
    assert chart_title is not None
    assert (
        chart_title.symbol,
        chart_title.last_price,
        chart_title.change,
        chart_title.direction,
    ) == expected


@pytest.mark.parametrize(
    "window_title",
    [None, "", "Jer Bud • HBO Max - Google Chrome", "Settings", "inbox (3) - Gmail"],
)
def test_ignores_titles_without_a_quote(window_title: str | None) -> None:
    assert parse_chart_title(window_title) is None
