"""Which window is showing the watched chart, and what its title says.

Broker and charting apps put the instrument in the window title, e.g. TradingView in Chrome:
"SPX 6,910.39 ▼ −3.7% - Google Chrome". The title is real, on-screen information, so the
app can show which symbol is being watched (and the last price the title displays) and say
exactly where that came from.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass

# Windows that are never the chart (the app itself, the desktop).
EXCLUDED_TITLE_FRAGMENTS = ("Maison Terminal", "Program Manager")
DWMWA_CLOAKED = 14  # hidden UWP / virtual-desktop windows report as visible but cloaked

_INVISIBLE_CHARACTERS = re.compile("[⁦-⁩‎‏‪-‮]")
_APP_SUFFIX = re.compile(
    r"\s+[-–—]\s+(Google Chrome|Microsoft\s*Edge|Mozilla Firefox|Firefox|Brave|Opera|Vivaldi|"
    r"Safari|Arc|TradingView)\s*$",
    re.IGNORECASE,
)
_CHART_TITLE = re.compile(
    r"^\s*(?:[A-Z0-9_]+:)?(?P<symbol>[A-Z0-9][A-Z0-9.!/_-]{0,19})\s+"
    r"(?P<price>\d[\d,]*(?:\.\d+)?)"
    r"(?:\s*(?P<arrow>[▲▼]))?"
    r"(?:\s*(?P<change>[+\-−]?\d[\d.,]*%))?"
)


@dataclass(frozen=True)
class ChartTitle:
    symbol: str
    last_price: str | None
    change: str | None  # e.g. "−3.7%" as displayed
    direction: str | None  # "up" | "down" | None


def clean_window_title(window_title: str) -> str:
    without_invisible = _INVISIBLE_CHARACTERS.sub("", window_title).strip()
    return _APP_SUFFIX.sub("", without_invisible).strip()


def parse_chart_title(window_title: str | None) -> ChartTitle | None:
    """Extract "SYMBOL PRICE [▲▼] [CHANGE%]" from a chart window title, if present."""
    if not window_title:
        return None
    title_match = _CHART_TITLE.match(clean_window_title(window_title))
    if title_match is None:
        return None
    arrow = title_match.group("arrow")
    return ChartTitle(
        symbol=title_match.group("symbol"),
        last_price=title_match.group("price"),
        change=title_match.group("change"),
        direction={"▲": "up", "▼": "down"}.get(arrow) if arrow else None,
    )


def window_title_at(screen_x: int, screen_y: int) -> str | None:
    """Title of the topmost visible window covering a screen point (Windows only)."""
    if sys.platform != "win32":
        return None
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    dwmapi = ctypes.windll.dwmapi
    topmost_titles: list[str] = []
    enum_windows_callback = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def visit_window(window_handle: int, _parameter: int) -> bool:
        if not user32.IsWindowVisible(window_handle) or user32.IsIconic(window_handle):
            return True
        title_length = user32.GetWindowTextLengthW(window_handle)
        if title_length == 0:
            return True
        window_rect = wintypes.RECT()
        user32.GetWindowRect(window_handle, ctypes.byref(window_rect))
        covers_point = (
            window_rect.left <= screen_x < window_rect.right
            and window_rect.top <= screen_y < window_rect.bottom
        )
        if not covers_point:
            return True
        cloaked_flag = ctypes.c_int(0)
        dwmapi.DwmGetWindowAttribute(
            window_handle, DWMWA_CLOAKED, ctypes.byref(cloaked_flag), ctypes.sizeof(cloaked_flag)
        )
        if cloaked_flag.value:
            return True
        title_buffer = ctypes.create_unicode_buffer(title_length + 1)
        user32.GetWindowTextW(window_handle, title_buffer, title_length + 1)
        if any(fragment in title_buffer.value for fragment in EXCLUDED_TITLE_FRAGMENTS):
            return True
        topmost_titles.append(title_buffer.value)
        return False  # windows are enumerated top-down; the first match is on top

    user32.EnumWindows(enum_windows_callback(visit_window), 0)
    return topmost_titles[0] if topmost_titles else None
