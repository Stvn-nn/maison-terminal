"""Uniform API error type and envelope.

Every non-2xx response from the sidecar has the shape::

    {"error": {"code": "<machine_code>", "message": "<human text>", "details": <any|null>}}
"""

from __future__ import annotations

from typing import Any


class ApiError(Exception):
    """Raised by domain code to produce a structured HTTP error response."""

    def __init__(
        self,
        status_code: int,
        error_code: str,
        message: str,
        details: Any | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.error_code = error_code
        self.message = message
        self.details = details

    def to_payload(self) -> dict[str, Any]:
        return {
            "error": {
                "code": self.error_code,
                "message": self.message,
                "details": self.details,
            }
        }
