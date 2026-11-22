from __future__ import annotations

import base64
import json

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from schemas import (
    BACKTRACK_REQUIRED_MESSAGE,
    CandleColorProfile,
    ScreenRegion,
    VisionAnalysis,
    VisionConfig,
    VisionState,
    WsEventType,
)
from tests.chart_rendering import (
    LIGHT_THEME,
    PRICE_AXIS_X,
    TIME_AXIS_Y,
    render_chart,
    sine_closes,
)
from tests.conftest import build_test_settings
from vision import (
    REASON_HISTORY_START,
    REASON_INSUFFICIENT_SWINGS,
    REASON_MAJOR_HIGH_AT_EDGE,
    REASON_NO_CHART,
    BacktrackDebouncer,
    VisionService,
    analyze_chart_image,
    decode_image,
)
from ws import WebSocketBroadcaster

# Several full swings, gently rising, starting mid-range: structure fully visible.
VISIBLE_STRUCTURE_CLOSES = sine_closes(
    bar_count=88, base_price=100, amplitude=10, period_bars=28, drift_per_bar=0.08
)
# Falling from the very first candle: the major high is at the left edge.
CUT_OFF_HIGH_CLOSES = sine_closes(
    bar_count=88, base_price=130, amplitude=3, period_bars=20, drift_per_bar=-0.45, phase_bars=5
)


def encode_png(image: np.ndarray) -> str:
    encoded_ok, png_buffer = cv2.imencode(".png", image)
    assert encoded_ok
    return base64.b64encode(png_buffer.tobytes()).decode("ascii")


class TestAnalyzeChartImage:
    def test_detects_plot_bounds_inside_axes(self) -> None:
        analysis = analyze_chart_image(render_chart(VISIBLE_STRUCTURE_CLOSES))
        assert analysis.chart_bounds is not None
        assert analysis.chart_bounds.x + analysis.chart_bounds.width == PRICE_AXIS_X
        assert analysis.chart_bounds.y + analysis.chart_bounds.height == TIME_AXIS_Y

    def test_visible_structure_is_not_truncated(self) -> None:
        analysis = analyze_chart_image(render_chart(VISIBLE_STRUCTURE_CLOSES))
        assert analysis.structure_truncated is False, analysis.reasons
        swing_kinds = [point.kind for point in analysis.swing_points]
        assert swing_kinds.count("high") >= 2
        assert swing_kinds.count("low") >= 2
        assert analysis.data_coverage > 0.5

    def test_major_high_at_left_edge_is_truncated(self) -> None:
        analysis = analyze_chart_image(render_chart(CUT_OFF_HIGH_CLOSES))
        assert analysis.structure_truncated is True
        assert REASON_MAJOR_HIGH_AT_EDGE in analysis.reasons
        assert analysis.confidence > 0.5

    def test_single_leg_without_swings_is_truncated(self) -> None:
        straight_rally = [100 + 0.5 * bar_index for bar_index in range(88)]
        analysis = analyze_chart_image(render_chart(straight_rally, draw_price_line=False))
        assert analysis.structure_truncated is True
        assert REASON_INSUFFICIENT_SWINGS in analysis.reasons

    def test_history_start_visible_needs_no_backtrack(self) -> None:
        analysis = analyze_chart_image(render_chart(CUT_OFF_HIGH_CLOSES[:50], first_candle_x=300))
        assert analysis.structure_truncated is False
        assert analysis.reasons == [REASON_HISTORY_START]

    def test_blank_screen_is_no_chart(self) -> None:
        blank_image = np.full((400, 600, 3), 30, dtype=np.uint8)
        analysis = analyze_chart_image(blank_image)
        assert analysis.reasons == [REASON_NO_CHART]
        assert analysis.structure_truncated is False

    def test_monochrome_light_theme(self) -> None:
        visible = analyze_chart_image(render_chart(VISIBLE_STRUCTURE_CLOSES, theme=LIGHT_THEME))
        cut_off = analyze_chart_image(render_chart(CUT_OFF_HIGH_CLOSES, theme=LIGHT_THEME))
        assert visible.structure_truncated is False, visible.reasons
        assert cut_off.structure_truncated is True

    def test_crosshair_and_bright_gridlines_are_ignored(self) -> None:
        chart_image = render_chart(VISIBLE_STRUCTURE_CLOSES)
        for gridline_y in (120, 240, 360):
            cv2.line(chart_image, (0, gridline_y), (PRICE_AXIS_X - 1, gridline_y), (90, 90, 90), 1)
        cv2.line(chart_image, (40, 0), (40, TIME_AXIS_Y - 1), (200, 200, 200), 1)  # crosshair
        analysis = analyze_chart_image(chart_image)
        assert analysis.structure_truncated is False, analysis.reasons

    def test_explicit_profile_and_plot_override(self) -> None:
        from schemas import PixelRect

        analysis = analyze_chart_image(
            render_chart(CUT_OFF_HIGH_CLOSES),
            color_profile=CandleColorProfile.GREEN_RED,
            plot_bounds_override=PixelRect(x=0, y=0, width=PRICE_AXIS_X, height=TIME_AXIS_Y),
        )
        assert analysis.structure_truncated is True


def make_analysis(truncated: bool, reasons: list[str] | None = None) -> VisionAnalysis:
    return VisionAnalysis(
        captured_at="2026-11-21T00:00:00Z",
        image_width=800,
        image_height=500,
        chart_bounds=None,
        data_left_x=0,
        data_coverage=0.8,
        swing_points=[],
        structure_truncated=truncated,
        reasons=reasons
        if reasons is not None
        else ([REASON_MAJOR_HIGH_AT_EDGE] if truncated else []),
        confidence=0.9,
    )


class TestBacktrackDebouncer:
    def test_requires_consecutive_frames_then_clears(self) -> None:
        debouncer = BacktrackDebouncer(confirm_frames=3, cooldown_seconds=0)
        assert debouncer.update(make_analysis(True)) is None
        assert debouncer.update(make_analysis(True)) is None
        assert debouncer.update(make_analysis(True)) == WsEventType.BACKTRACK_REQUIRED
        assert debouncer.state == VisionState.BACKTRACK_REQUIRED
        assert debouncer.update(make_analysis(True)) is None  # no repeat while active
        assert debouncer.update(make_analysis(False)) is None
        assert debouncer.update(make_analysis(False)) is None
        assert debouncer.update(make_analysis(False)) == WsEventType.BACKTRACK_CLEARED
        assert debouncer.state == VisionState.STRUCTURE_VISIBLE

    def test_flicker_does_not_alert(self) -> None:
        debouncer = BacktrackDebouncer(confirm_frames=2, cooldown_seconds=0)
        for frame_truncated in (True, False, True, False, True, False):
            assert debouncer.update(make_analysis(frame_truncated)) is None

    def test_cooldown_suppresses_rapid_realerts(self) -> None:
        fake_now = [100.0]
        debouncer = BacktrackDebouncer(
            confirm_frames=1, cooldown_seconds=30, clock=lambda: fake_now[0]
        )
        assert debouncer.update(make_analysis(True)) == WsEventType.BACKTRACK_REQUIRED
        assert debouncer.update(make_analysis(False)) == WsEventType.BACKTRACK_CLEARED
        fake_now[0] += 10
        assert debouncer.update(make_analysis(True)) is None
        fake_now[0] += 25
        assert debouncer.update(make_analysis(True)) == WsEventType.BACKTRACK_REQUIRED

    def test_no_chart_frames_change_nothing(self) -> None:
        debouncer = BacktrackDebouncer(confirm_frames=1, cooldown_seconds=0)
        assert debouncer.update(make_analysis(True)) == WsEventType.BACKTRACK_REQUIRED
        assert debouncer.update(make_analysis(False, [REASON_NO_CHART])) is None
        assert debouncer.state == VisionState.BACKTRACK_REQUIRED


class RecordingSocket:
    def __init__(self) -> None:
        self.frames: list[dict] = []

    async def send_text(self, payload: str) -> None:
        self.frames.append(json.loads(payload))


async def test_service_broadcasts_exact_backtrack_payload() -> None:
    broadcaster = WebSocketBroadcaster()
    recording_socket = RecordingSocket()
    await broadcaster.register(recording_socket)  # type: ignore[arg-type]
    vision_service = VisionService(build_test_settings(vision_confirm_frames=2), broadcaster)
    config = VisionConfig(region=ScreenRegion(left=0, top=0, width=800, height=500))
    cut_off_frame = render_chart(CUT_OFF_HIGH_CLOSES)
    visible_frame = render_chart(VISIBLE_STRUCTURE_CLOSES)
    try:
        await vision_service.process_frame(cut_off_frame, config)
        assert recording_socket.frames == []
        await vision_service.process_frame(cut_off_frame, config)
        await vision_service.process_frame(visible_frame, config)
        await vision_service.process_frame(visible_frame, config)
    finally:
        await vision_service.shutdown()

    events = [frame["event"] for frame in recording_socket.frames]
    assert events == ["BACKTRACK_REQUIRED", "BACKTRACK_CLEARED"]
    alert_frame = recording_socket.frames[0]
    assert alert_frame["message"] == BACKTRACK_REQUIRED_MESSAGE
    assert alert_frame["message"] == (
        "Historical Context Needed: Please scroll back on your trading chart"
    )
    assert REASON_MAJOR_HIGH_AT_EDGE in alert_frame["data"]["reasons"]


def test_decode_image_rejects_garbage() -> None:
    from errors import ApiError

    with pytest.raises(ApiError):
        decode_image("not base64!!")
    with pytest.raises(ApiError):
        decode_image(base64.b64encode(b"plain text").decode())


class TestVisionEndpoints:
    def test_check_with_uploaded_image(self, client: TestClient) -> None:
        response = client.post(
            "/api/v1/vision/check",
            json={
                "image_base64": "data:image/png;base64,"
                + encode_png(render_chart(CUT_OFF_HIGH_CLOSES))
            },
        )
        assert response.status_code == 200
        assert response.json()["structure_truncated"] is True

    def test_requires_config_before_start_or_capture(self, client: TestClient) -> None:
        assert client.get("/api/v1/vision/status").json()["state"] == "idle"
        start_response = client.post("/api/v1/vision/start")
        assert start_response.status_code == 409
        assert start_response.json()["error"]["code"] == "vision_not_configured"
        assert client.post("/api/v1/vision/check", json={}).status_code == 409

    def test_configure_and_stop(self, client: TestClient) -> None:
        config_payload = {"region": {"left": 0, "top": 0, "width": 640, "height": 400}}
        status_body = client.put("/api/v1/vision/config", json=config_payload).json()
        assert status_body["config"]["region"]["width"] == 640
        assert client.post("/api/v1/vision/stop").json()["running"] is False

    def test_rejects_tiny_region(self, client: TestClient) -> None:
        response = client.put(
            "/api/v1/vision/config",
            json={"region": {"left": 0, "top": 0, "width": 10, "height": 10}},
        )
        assert response.status_code == 422


# --------------------------------------------------------------------------------------
# Multi-monitor clipping and following a chart window
# --------------------------------------------------------------------------------------


def _monitor(index: int, left: int, top: int, width: int, height: int):
    from schemas import MonitorInfo

    return MonitorInfo(
        index=index, left=left, top=top, width=width, height=height, is_virtual_desktop=index == 0
    )


DUAL_MONITORS = [
    _monitor(0, -1920, 0, 4480, 1600),  # virtual desktop spanning both
    _monitor(1, 0, 0, 2560, 1600),  # primary
    _monitor(2, -1920, 200, 1920, 1080),  # secondary, left of the primary
]


def test_clip_picks_the_monitor_showing_most_of_the_window() -> None:
    from vision import clip_to_best_monitor

    # Mostly on the left (secondary) monitor, a little on the primary.
    monitor, region = clip_to_best_monitor(-1800, 300, 200, 1100, DUAL_MONITORS)
    assert monitor.index == 2
    assert region == ScreenRegion(left=-1800, top=300, width=1800, height=800)


def test_clip_handles_a_window_only_on_the_secondary_monitor() -> None:
    from vision import clip_to_best_monitor

    monitor, region = clip_to_best_monitor(-1500, 400, -300, 1000, DUAL_MONITORS)
    assert monitor.index == 2
    assert region.width == 1200


def test_clip_rejects_a_window_that_is_off_screen() -> None:
    from vision import clip_to_best_monitor

    assert clip_to_best_monitor(5000, 5000, 6000, 6000, DUAL_MONITORS) is None


async def test_hidden_chart_window_keeps_last_candles_and_reports_out_of_view(monkeypatch) -> None:
    import window_info
    from schemas import Candle

    vision_service = VisionService(build_test_settings(), WebSocketBroadcaster())
    chart_window = window_info.ScreenWindow("SPX 6,910.39 ▼ −3.7%", 0, 0, 1200, 800, handle=42)
    vision_service.configure(
        VisionConfig(region=ScreenRegion(left=0, top=0, width=1200, height=800)),
        tracked_window=chart_window,
    )
    vision_service._screen_candles = [
        Candle(time=1, open=150, high=160, low=140, close=155),
        Candle(time=2, open=155, high=170, low=150, close=165),
    ]
    monkeypatch.setattr(window_info, "window_by_handle", lambda handle: None)  # minimised
    visibility, region = vision_service._follow_tracked_window()
    assert (visibility, region) == ("hidden", None)

    vision_service._chart_in_view = False
    monkeypatch.setattr(VisionService, "is_running", property(lambda self: True))
    response = vision_service.screen_candles()
    assert response.available is True
    assert response.in_view is False
    assert len(response.candles) == 2
    assert response.symbol == "SPX"
    await vision_service.shutdown()


async def test_followed_window_moving_to_another_monitor_updates_the_region(monkeypatch) -> None:
    import window_info

    vision_service = VisionService(build_test_settings(), WebSocketBroadcaster())
    vision_service._monitors = DUAL_MONITORS
    vision_service.configure(
        VisionConfig(region=ScreenRegion(left=100, top=100, width=1200, height=800)),
        tracked_window=window_info.ScreenWindow("EURUSD 1.0975", 100, 100, 1300, 900, handle=7),
    )
    vision_service._monitors = DUAL_MONITORS
    moved_window = window_info.ScreenWindow("EURUSD 1.0975", -1700, 300, -500, 1100, handle=7)
    monkeypatch.setattr(window_info, "window_by_handle", lambda handle: moved_window)
    monkeypatch.setattr(window_info, "covered_fraction", lambda window: 0.0)
    visibility, region = vision_service._follow_tracked_window()
    assert visibility == "visible"
    assert region == ScreenRegion(left=-1700, top=300, width=1200, height=800)

    monkeypatch.setattr(window_info, "covered_fraction", lambda window: 0.8)
    assert vision_service._follow_tracked_window() == ("covered", None)
    await vision_service.shutdown()
