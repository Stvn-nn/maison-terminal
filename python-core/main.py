"""Maison Terminal analytical sidecar: FastAPI REST API + WebSocket broadcaster.

Run locally::

    python main.py            # binds 127.0.0.1:8000 by default (MT_HOST / MT_PORT)
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime

import uvicorn
from fastapi import Depends, FastAPI, Request, WebSocket, WebSocketDisconnect, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError

import indicators
import news_feed
import vision
from config import Settings, finnhub_key, get_settings
from errors import ApiError
from schemas import HealthResponse, SizingRequest, SizingResponse, WsClientMessage, WsEventType
from sizing import calculate_position_size
from ws import WebSocketBroadcaster, build_event

SERVICE_VERSION = "0.1.0"
API_PREFIX = "/api/v1"

logger = logging.getLogger("maison")


def _expected_token(settings: Settings) -> str | None:
    if settings.auth_token is None:
        return None
    token_value = settings.auth_token.get_secret_value()
    return token_value or None


def _token_matches(provided_token: str | None, expected_token: str) -> bool:
    return provided_token is not None and secrets.compare_digest(provided_token, expected_token)


def require_api_token(request: Request) -> None:
    """Reject REST calls without the per-launch bearer token (when one is configured)."""
    expected_token = _expected_token(request.app.state.settings)
    if expected_token is None:
        return
    authorization_header = request.headers.get("authorization", "")
    scheme, _, provided_token = authorization_header.partition(" ")
    if scheme.lower() != "bearer" or not _token_matches(provided_token, expected_token):
        raise ApiError(status.HTTP_401_UNAUTHORIZED, "unauthorized", "Missing or invalid token")


def create_app(settings: Settings | None = None) -> FastAPI:
    app_settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        broadcaster: WebSocketBroadcaster = app.state.broadcaster
        macro_service: news_feed.MacroFeedService = app.state.macro_service
        background_tasks = [asyncio.create_task(broadcaster.run_heartbeat())]
        if app_settings.macro_poll_enabled and macro_service.is_configured:
            background_tasks.append(asyncio.create_task(macro_service.run_poller()))
        elif not macro_service.is_configured:
            logger.info("FINNHUB_API_KEY not set; macro calendar and news are disabled")
        logger.info("Maison Terminal core started on %s:%s", app_settings.host, app_settings.port)
        try:
            yield
        finally:
            await app.state.vision_service.shutdown()
            for task in background_tasks:
                task.cancel()
            for task in background_tasks:
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            await macro_service.aclose()

    app = FastAPI(
        title="Maison Terminal Core",
        version=SERVICE_VERSION,
        description="Local analytical sidecar for the Maison Terminal desktop app.",
        lifespan=lifespan,
    )
    app.state.settings = app_settings
    app.state.broadcaster = WebSocketBroadcaster()
    app.state.vision_service = vision.VisionService(app_settings, app.state.broadcaster)
    app.state.macro_service = news_feed.MacroFeedService(app_settings, app.state.broadcaster)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=app_settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )
    _register_error_handlers(app)
    _register_core_routes(app)
    app.include_router(indicators.build_router(require_api_token))
    app.include_router(vision.build_router(require_api_token))
    app.include_router(news_feed.build_router(require_api_token))
    _register_websocket(app)
    return app


def _register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def handle_api_error(_request: Request, api_error: ApiError) -> JSONResponse:
        return JSONResponse(status_code=api_error.status_code, content=api_error.to_payload())

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(
        _request: Request, validation_error: RequestValidationError
    ) -> JSONResponse:
        api_error = ApiError(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "validation_error",
            "Request body or parameters are invalid",
            details=json.loads(json.dumps(validation_error.errors(), default=str)),
        )
        return JSONResponse(status_code=api_error.status_code, content=api_error.to_payload())

    @app.exception_handler(Exception)
    async def handle_unexpected_error(
        _request: Request, unexpected_error: Exception
    ) -> JSONResponse:
        logger.exception("Unhandled error", exc_info=unexpected_error)
        api_error = ApiError(500, "internal_error", "Unexpected server error")
        return JSONResponse(status_code=500, content=api_error.to_payload())


def _register_core_routes(app: FastAPI) -> None:
    @app.get("/health", response_model=HealthResponse, tags=["system"])
    async def health(request: Request) -> HealthResponse:
        vision_service = getattr(request.app.state, "vision_service", None)
        return HealthResponse(
            version=SERVICE_VERSION,
            server_time=datetime.now(UTC),
            finnhub_configured=finnhub_key(request.app.state.settings) is not None,
            vision_running=bool(vision_service and vision_service.is_running),
            websocket_clients=request.app.state.broadcaster.client_count,
        )

    @app.post(
        f"{API_PREFIX}/sizing/calculate",
        response_model=SizingResponse,
        tags=["sizing"],
        dependencies=[Depends(require_api_token)],
    )
    async def calculate_sizing(sizing_request: SizingRequest) -> SizingResponse:
        return calculate_position_size(sizing_request)


def _register_websocket(app: FastAPI) -> None:
    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        settings: Settings = websocket.app.state.settings
        broadcaster: WebSocketBroadcaster = websocket.app.state.broadcaster

        origin = websocket.headers.get("origin")
        if origin is not None and origin not in settings.cors_origins:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        expected_token = _expected_token(settings)
        if expected_token is not None and not _token_matches(
            websocket.query_params.get("token"), expected_token
        ):
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return

        await websocket.accept()
        await broadcaster.register(websocket)
        await broadcaster.send_event(
            websocket,
            build_event(
                WsEventType.HELLO,
                "Maison Terminal core connected",
                {"version": SERVICE_VERSION},
            ),
        )
        try:
            while True:
                raw_frame = await websocket.receive_text()
                try:
                    WsClientMessage.model_validate_json(raw_frame)
                except ValidationError:
                    await broadcaster.send_event(
                        websocket,
                        build_event(
                            WsEventType.ERROR,
                            'Unsupported message; send {"action": "ping"}',
                        ),
                    )
                    continue
                await broadcaster.send_event(websocket, build_event(WsEventType.PONG, "pong"))
        except WebSocketDisconnect:
            pass
        finally:
            await broadcaster.unregister(websocket)


app = create_app()


if __name__ == "__main__":
    runtime_settings = get_settings()
    logging.basicConfig(
        level=runtime_settings.log_level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    uvicorn.run(
        app,
        host=runtime_settings.host,
        port=runtime_settings.port,
        log_level=runtime_settings.log_level.lower(),
    )
