"""Runtime configuration for the Maison Terminal sidecar.

All values come from environment variables (prefix ``MT_``) or a local ``.env``
file. Secrets such as the Finnhub key are never logged or returned by the API.
"""

from __future__ import annotations

import os
from functools import lru_cache

from pydantic import AliasChoices, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="MT_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    host: str = "127.0.0.1"
    port: int = 8000
    log_level: str = "INFO"

    # Optional per-launch shared secret. When set, REST calls must send
    # ``Authorization: Bearer <token>`` and WebSocket clients ``?token=<token>``.
    auth_token: SecretStr | None = None

    cors_origins: list[str] = Field(
        default_factory=lambda: [
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
            "http://localhost:1420",
            "http://127.0.0.1:1420",
            "http://localhost:5173",
        ]
    )

    # Finnhub. Read from MT_FINNHUB_API_KEY or FINNHUB_API_KEY, in the environment or in .env
    # (the desktop app saves the key the user enters to .env as MT_FINNHUB_API_KEY).
    finnhub_api_key: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices("MT_FINNHUB_API_KEY", "FINNHUB_API_KEY", "finnhub_api_key"),
    )
    finnhub_base_url: str = "https://finnhub.io/api/v1"
    finnhub_calls_per_minute: int = 55
    calendar_cache_seconds: int = 60
    news_cache_seconds: int = 30

    # Background macro poller.
    macro_poll_enabled: bool = True
    macro_poll_seconds: int = 60
    macro_alert_lead_minutes: int = 15

    # Screen vision loop.
    vision_interval_seconds: float = 0.75
    vision_left_margin_pct: float = 0.05
    vision_confirm_frames: int = 3
    vision_cooldown_seconds: float = 20.0

    # Request guards.
    max_candles: int = 20_000
    max_indicators: int = 32


@lru_cache
def get_settings() -> Settings:
    return Settings()


def finnhub_key(settings: Settings) -> str | None:
    """Return the Finnhub key from ``MT_FINNHUB_API_KEY`` or ``FINNHUB_API_KEY``."""
    if settings.finnhub_api_key is not None:
        value = settings.finnhub_api_key.get_secret_value().strip()
        if value:
            return value
    value = os.environ.get("FINNHUB_API_KEY", "").strip()
    return value or None
