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


@dataclass(frozen=True)
class ScreenWindow:
    title: str
    left: int
    top: int
    right: int
    bottom: int

    @property
    def area(self) -> int:
        return max(0, self.right - self.left) * max(0, self.bottom - self.top)


def visible_windows() -> list[ScreenWindow]:
    """Visible, titled, on-screen windows, topmost first (Windows only; [] elsewhere)."""
    if sys.platform != "win32":
        return []
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    dwmapi = ctypes.windll.dwmapi
    windows: list[ScreenWindow] = []
    enum_windows_callback = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def visit_window(window_handle: int, _parameter: int) -> bool:
        if not user32.IsWindowVisible(window_handle) or user32.IsIconic(window_handle):
            return True
        title_length = user32.GetWindowTextLengthW(window_handle)
        if title_length == 0:
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
        window_rect = wintypes.RECT()
        user32.GetWindowRect(window_handle, ctypes.byref(window_rect))
        windows.append(
            ScreenWindow(
                title_buffer.value,
                window_rect.left,
                window_rect.top,
                window_rect.right,
                window_rect.bottom,
            )
        )
        return True

    user32.EnumWindows(enum_windows_callback(visit_window), 0)
    return windows


def window_title_at(screen_x: int, screen_y: int) -> str | None:
    """Title of the topmost visible window covering a screen point (Windows only)."""
    for window in visible_windows():
        if window.left <= screen_x < window.right and window.top <= screen_y < window.bottom:
            return window.title
    return None


def find_chart_window() -> ScreenWindow | None:
    """The largest visible window whose title reads like a chart ("SPX 6,910.39 ▼ ...")."""
    chart_windows = [window for window in visible_windows() if parse_chart_title(window.title)]
    return max(chart_windows, key=lambda window: window.area, default=None)
