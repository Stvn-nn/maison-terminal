"""Which window is showing the watched chart, and what its title says.

Broker and charting apps put the instrument in the window title, e.g. TradingView in Chrome:
"SPX 6,910.39 ▼ −3.7% - Google Chrome". The title is real, on-screen information, so the
app can show which symbol is being watched (and the last price the title displays) and say
exactly where that came from.
"""

from __future__ import annotations

import contextlib
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
    handle: int = 0  # Win32 HWND, so a watched window can be followed when it moves

    @property
    def area(self) -> int:
        return max(0, self.right - self.left) * max(0, self.bottom - self.top)


_dpi_awareness_requested = False


def _ensure_per_monitor_dpi_awareness() -> None:
    """Report window rectangles in physical pixels on every monitor, matching screen capture.

    Without this, a window on a 150 %-scaled second monitor reports scaled coordinates and the
    watched region lands in the wrong place. Harmless if awareness was already set (mss does).
    """
    global _dpi_awareness_requested
    if _dpi_awareness_requested:
        return
    _dpi_awareness_requested = True
    import ctypes

    per_monitor_aware_v2 = ctypes.c_void_p(-4)
    with contextlib.suppress(AttributeError, OSError):
        ctypes.windll.user32.SetProcessDpiAwarenessContext(per_monitor_aware_v2)


def _read_window(window_handle: int) -> ScreenWindow | None:
    """A shown (visible, not minimised, not cloaked) window's title and rectangle."""
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    if not user32.IsWindow(window_handle):
        return None
    if not user32.IsWindowVisible(window_handle) or user32.IsIconic(window_handle):
        return None
    cloaked_flag = ctypes.c_int(0)
    ctypes.windll.dwmapi.DwmGetWindowAttribute(
        window_handle, DWMWA_CLOAKED, ctypes.byref(cloaked_flag), ctypes.sizeof(cloaked_flag)
    )
    if cloaked_flag.value:
        return None
    title_length = user32.GetWindowTextLengthW(window_handle)
    title_buffer = ctypes.create_unicode_buffer(title_length + 1)
    user32.GetWindowTextW(window_handle, title_buffer, title_length + 1)
    window_rect = wintypes.RECT()
    user32.GetWindowRect(window_handle, ctypes.byref(window_rect))
    return ScreenWindow(
        title_buffer.value,
        window_rect.left,
        window_rect.top,
        window_rect.right,
        window_rect.bottom,
        int(window_handle),
    )


def visible_windows() -> list[ScreenWindow]:
    """Visible, titled, on-screen windows, topmost first (Windows only; [] elsewhere)."""
    if sys.platform != "win32":
        return []
    import ctypes
    from ctypes import wintypes

    _ensure_per_monitor_dpi_awareness()
    windows: list[ScreenWindow] = []
    enum_windows_callback = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def visit_window(window_handle: int, _parameter: int) -> bool:
        window = _read_window(window_handle)
        if window is None or not window.title:
            return True
        if any(fragment in window.title for fragment in EXCLUDED_TITLE_FRAGMENTS):
            return True
        windows.append(window)
        return True

    ctypes.windll.user32.EnumWindows(enum_windows_callback(visit_window), 0)
    return windows


def window_by_handle(window_handle: int) -> ScreenWindow | None:
    """The window's current title and position, or None if it was closed, minimised or hidden."""
    if sys.platform != "win32" or not window_handle:
        return None
    _ensure_per_monitor_dpi_awareness()
    return _read_window(window_handle)


def covered_fraction(window: ScreenWindow) -> float:
    """Share of sample points inside the window where another window is drawn on top.

    Samples the centre and four inner points; a chart under another app (including Maison
    Terminal itself) cannot be read, so the watch pauses instead of reading the wrong pixels.
    """
    if sys.platform != "win32" or not window.handle:
        return 0.0
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    user32.WindowFromPoint.restype = wintypes.HWND
    user32.WindowFromPoint.argtypes = [wintypes.POINT]
    user32.GetAncestor.restype = wintypes.HWND
    user32.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
    get_ancestor_root = 2
    width = window.right - window.left
    height = window.bottom - window.top
    sample_fractions = [(0.5, 0.5), (0.25, 0.3), (0.75, 0.3), (0.25, 0.75), (0.75, 0.75)]
    covered_points = 0
    for fraction_x, fraction_y in sample_fractions:
        sample_point = wintypes.POINT(
            window.left + int(width * fraction_x), window.top + int(height * fraction_y)
        )
        window_at_point = user32.WindowFromPoint(sample_point)
        top_level_window = (
            user32.GetAncestor(window_at_point, get_ancestor_root) if window_at_point else None
        )
        if (top_level_window or 0) != window.handle:
            covered_points += 1
    return covered_points / len(sample_fractions)


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
