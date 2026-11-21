from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from config import Settings
from main import create_app

TEST_TOKEN = "test-token-not-a-secret"  # noqa: S105 - fixture value only


def build_test_settings(**overrides: object) -> Settings:
    base_values: dict[str, object] = {
        "auth_token": None,
        "finnhub_api_key": None,
        "macro_poll_enabled": False,
        "vision_confirm_frames": 2,
        "vision_cooldown_seconds": 0.0,
    }
    base_values.update(overrides)
    return Settings(_env_file=None, **base_values)


@pytest.fixture(autouse=True)
def isolate_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FINNHUB_API_KEY", raising=False)
    monkeypatch.delenv("MT_FINNHUB_API_KEY", raising=False)
    monkeypatch.delenv("MT_AUTH_TOKEN", raising=False)


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(create_app(build_test_settings())) as test_client:
        yield test_client


@pytest.fixture
def authed_client() -> Iterator[TestClient]:
    with TestClient(create_app(build_test_settings(auth_token=TEST_TOKEN))) as test_client:
        yield test_client
