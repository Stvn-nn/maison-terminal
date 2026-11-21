"""Generate machine-readable API contracts for the frontend.

Writes, relative to the repository root:

* ``docs/contract/openapi.json``          REST API (FastAPI OpenAPI 3 schema)
* ``docs/contract/ws-events.schema.json`` WebSocket envelope + per-event ``data`` schemas

Run after changing ``schemas.py``::

    python export_contract.py          # write files
    python export_contract.py --check  # exit 1 if committed files are stale (CI / tests)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from pydantic.json_schema import models_json_schema

from config import Settings
from main import create_app
from schemas import (
    BACKTRACK_CLEARED_MESSAGE,
    BACKTRACK_REQUIRED_MESSAGE,
    WS_EVENT_DATA_MODELS,
    WsClientMessage,
    WsEvent,
)

REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
CONTRACT_DIRECTORY = REPOSITORY_ROOT / "docs" / "contract"
OPENAPI_PATH = CONTRACT_DIRECTORY / "openapi.json"
WS_SCHEMA_PATH = CONTRACT_DIRECTORY / "ws-events.schema.json"

FIXED_EVENT_MESSAGES = {
    "BACKTRACK_REQUIRED": BACKTRACK_REQUIRED_MESSAGE,
    "BACKTRACK_CLEARED": BACKTRACK_CLEARED_MESSAGE,
    "PONG": "pong",
    "HEARTBEAT": "alive",
}


def build_openapi_document() -> dict[str, Any]:
    return create_app(Settings(_env_file=None, macro_poll_enabled=False)).openapi()


def build_websocket_document() -> dict[str, Any]:
    data_models = sorted(
        {model for model in WS_EVENT_DATA_MODELS.values() if model is not None},
        key=lambda model: model.__name__,
    )
    all_models = [WsEvent, WsClientMessage, *data_models]
    model_references, shared_definitions = models_json_schema(
        [(model, "serialization") for model in all_models],
        ref_template="#/$defs/{model}",
    )

    def reference_for(model: type) -> dict[str, Any]:
        return model_references[(model, "serialization")]

    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "Maison Terminal WebSocket contract",
        "description": (
            "Connect to ws://127.0.0.1:8000/ws (append ?token=<token> when MT_AUTH_TOKEN is "
            "set). Every server frame is a WsEvent envelope. `event` and `message` are always "
            "present; `ts` (UTC ISO-8601) and `data` are additive."
        ),
        "envelope": reference_for(WsEvent),
        "client_message": reference_for(WsClientMessage),
        "events": {
            event_type.value: {
                "fixed_message": FIXED_EVENT_MESSAGES.get(event_type.value),
                "data": None if data_model is None else reference_for(data_model),
            }
            for event_type, data_model in WS_EVENT_DATA_MODELS.items()
        },
        "$defs": shared_definitions.get("$defs", {}),
    }


def render(document: dict[str, Any]) -> str:
    return json.dumps(document, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def expected_files() -> dict[Path, str]:
    return {
        OPENAPI_PATH: render(build_openapi_document()),
        WS_SCHEMA_PATH: render(build_websocket_document()),
    }


def _normalized_text(contract_path: Path) -> str:
    # Git may check files out with CRLF on Windows; compare content, not line endings.
    return contract_path.read_text(encoding="utf-8").replace("\r\n", "\n")


def stale_files() -> list[Path]:
    return [
        contract_path
        for contract_path, expected_content in expected_files().items()
        if not contract_path.exists() or _normalized_text(contract_path) != expected_content
    ]


def main(arguments: list[str]) -> int:
    if "--check" in arguments:
        outdated_paths = stale_files()
        for outdated_path in outdated_paths:
            print(f"stale: {outdated_path.relative_to(REPOSITORY_ROOT)}")
        return 1 if outdated_paths else 0

    CONTRACT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    for contract_path, content in expected_files().items():
        contract_path.write_text(content, encoding="utf-8", newline="\n")
        print(f"wrote {contract_path.relative_to(REPOSITORY_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
