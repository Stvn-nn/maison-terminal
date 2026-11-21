"""WebSocket connection registry and event broadcaster.

Every frame the server sends is a :class:`schemas.WsEvent` serialised to JSON. A slow or
dead client never blocks the others: each send has a timeout and failed clients are
dropped from the registry.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import WebSocket

from schemas import WsEvent, WsEventType

logger = logging.getLogger("maison.ws")

DEFAULT_SEND_TIMEOUT_SECONDS = 2.0
HEARTBEAT_INTERVAL_SECONDS = 20.0


def build_event(
    event_type: WsEventType, message: str, data: dict[str, Any] | None = None
) -> WsEvent:
    return WsEvent(event=event_type, message=message, ts=datetime.now(UTC), data=data)


class WebSocketBroadcaster:
    def __init__(self, send_timeout_seconds: float = DEFAULT_SEND_TIMEOUT_SECONDS) -> None:
        self._connections: set[WebSocket] = set()
        self._registry_lock = asyncio.Lock()
        self._send_timeout_seconds = send_timeout_seconds

    @property
    def client_count(self) -> int:
        return len(self._connections)

    async def register(self, websocket: WebSocket) -> None:
        async with self._registry_lock:
            self._connections.add(websocket)
        logger.info("WebSocket client connected (%d total)", self.client_count)

    async def unregister(self, websocket: WebSocket) -> None:
        async with self._registry_lock:
            self._connections.discard(websocket)
        logger.info("WebSocket client disconnected (%d total)", self.client_count)

    async def send_event(self, websocket: WebSocket, event: WsEvent) -> bool:
        """Send one event to one client. Returns False (and drops the client) on failure."""
        try:
            await asyncio.wait_for(
                websocket.send_text(event.model_dump_json()),
                timeout=self._send_timeout_seconds,
            )
            return True
        except Exception as send_error:  # noqa: BLE001 - any transport failure drops the client
            logger.debug("Dropping WebSocket client after send failure: %s", send_error)
            await self.unregister(websocket)
            return False

    async def broadcast(
        self,
        event_type: WsEventType,
        message: str,
        data: dict[str, Any] | None = None,
    ) -> int:
        """Send an event to every connected client and return how many received it."""
        event = build_event(event_type, message, data)
        async with self._registry_lock:
            recipients = list(self._connections)
        if not recipients:
            return 0
        delivery_results = await asyncio.gather(
            *(self.send_event(websocket, event) for websocket in recipients)
        )
        delivered_count = sum(delivery_results)
        logger.debug("Broadcast %s to %d/%d clients", event_type, delivered_count, len(recipients))
        return delivered_count

    async def run_heartbeat(self, interval_seconds: float = HEARTBEAT_INTERVAL_SECONDS) -> None:
        """Periodically broadcast HEARTBEAT so clients can detect a stalled sidecar."""
        while True:
            await asyncio.sleep(interval_seconds)
            await self.broadcast(WsEventType.HEARTBEAT, "alive")
