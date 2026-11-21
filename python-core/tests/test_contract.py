from __future__ import annotations

from export_contract import build_openapi_document, build_websocket_document, stale_files
from schemas import WS_EVENT_DATA_MODELS, WsEventType


def test_committed_contract_files_are_current() -> None:
    outdated_paths = stale_files()
    assert not outdated_paths, (
        f"Contract files are stale: {outdated_paths}. Run `python export_contract.py`."
    )


def test_openapi_lists_every_endpoint() -> None:
    documented_paths = set(build_openapi_document()["paths"])
    assert {
        "/health",
        "/api/v1/sizing/calculate",
        "/api/v1/indicators",
        "/api/v1/indicators/compute",
        "/api/v1/indicators/scan",
        "/api/v1/vision/monitors",
        "/api/v1/vision/status",
        "/api/v1/vision/config",
        "/api/v1/vision/start",
        "/api/v1/vision/stop",
        "/api/v1/vision/check",
        "/api/v1/macro/calendar",
        "/api/v1/macro/news",
        "/api/v1/macro/sentiment",
    } <= documented_paths


def test_websocket_contract_covers_every_event() -> None:
    websocket_document = build_websocket_document()
    assert set(websocket_document["events"]) == {event.value for event in WsEventType}
    assert set(WS_EVENT_DATA_MODELS) == set(WsEventType)
    assert websocket_document["events"]["BACKTRACK_REQUIRED"]["fixed_message"] == (
        "Historical Context Needed: Please scroll back on your trading chart"
    )
