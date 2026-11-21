from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from main import create_app
from schemas import WsEventType
from tests.conftest import TEST_TOKEN, build_test_settings


def test_health(client: TestClient) -> None:
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["finnhub_configured"] is False


def test_hello_then_ping_pong(client: TestClient) -> None:
    with client.websocket_connect("/ws") as websocket:
        hello = websocket.receive_json()
        assert hello["event"] == "HELLO"
        assert "ts" in hello
        websocket.send_json({"action": "ping"})
        assert websocket.receive_json()["event"] == "PONG"
        websocket.send_text("garbage")
        assert websocket.receive_json()["event"] == "ERROR"


def test_broadcast_reaches_every_client(client: TestClient) -> None:
    broadcaster = client.app.state.broadcaster
    with client.websocket_connect("/ws") as first, client.websocket_connect("/ws") as second:
        first.receive_json()
        second.receive_json()
        delivered = client.portal.call(
            broadcaster.broadcast,
            WsEventType.BACKTRACK_REQUIRED,
            "Historical Context Needed: Please scroll back on your trading chart",
        )
        assert delivered == 2
        for websocket in (first, second):
            frame = websocket.receive_json()
            assert frame["event"] == "BACKTRACK_REQUIRED"
            assert frame["message"] == (
                "Historical Context Needed: Please scroll back on your trading chart"
            )


def test_rejects_foreign_origin(client: TestClient) -> None:
    with (
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect("/ws", headers={"origin": "https://evil.example"}) as websocket,
    ):
        websocket.receive_json()


def test_token_required_when_configured() -> None:
    with TestClient(create_app(build_test_settings(auth_token=TEST_TOKEN))) as authed_client:
        with (
            pytest.raises(WebSocketDisconnect),
            authed_client.websocket_connect("/ws") as rejected_socket,
        ):
            rejected_socket.receive_json()
        with authed_client.websocket_connect(f"/ws?token={TEST_TOKEN}") as websocket:
            assert websocket.receive_json()["event"] == "HELLO"


async def test_dead_client_is_dropped() -> None:
    from ws import WebSocketBroadcaster

    class BrokenSocket:
        async def send_text(self, _payload: str) -> None:
            raise RuntimeError("socket closed")

    broadcaster = WebSocketBroadcaster(send_timeout_seconds=0.1)
    await broadcaster.register(BrokenSocket())  # type: ignore[arg-type]
    delivered = await broadcaster.broadcast(WsEventType.HEARTBEAT, "alive")
    assert delivered == 0
    assert broadcaster.client_count == 0
    await asyncio.sleep(0)
