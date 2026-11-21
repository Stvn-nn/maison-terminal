# Maison Terminal Core (Python sidecar)

Local FastAPI + WebSocket service behind the Maison Terminal desktop app: technical analysis,
screen vision ("scroll back" alerts), Finnhub macro feed and position sizing.

The frontend contract is in [`../docs/API_CONTRACT.md`](../docs/API_CONTRACT.md).

## Setup

Python 3.11–3.13 (developed on 3.12; 3.14 is not yet supported by the scientific wheels).

```bash
py -3.12 -m venv .venv
.venv/Scripts/python -m pip install -r requirements-dev.txt
copy .env.example .env   # then set FINNHUB_API_KEY (optional)
```

## Run

```bash
.venv/Scripts/python main.py
```

The service listens on `http://127.0.0.1:8000` (REST) and `ws://127.0.0.1:8000/ws`
(WebSocket). Interactive docs are at `/docs`.

| Variable | Default | Purpose |
|---|---|---|
| `MT_HOST` / `MT_PORT` | `127.0.0.1` / `8000` | Bind address |
| `MT_AUTH_TOKEN` | unset | Per-launch shared secret (Bearer header / `?token=`) |
| `FINNHUB_API_KEY` | unset | Enables `/api/v1/macro/*` and the macro poller |
| `MT_MACRO_POLL_ENABLED` | `true` | Background calendar/news broadcasts |
| `MT_MACRO_ALERT_LEAD_MINUTES` | `15` | Lead time for `MACRO_EVENT_UPCOMING` |
| `MT_VISION_INTERVAL_SECONDS` | `0.75` | Chart-watch capture interval |
| `MT_VISION_CONFIRM_FRAMES` | `3` | Frames needed to raise or clear a backtrack alert |
| `MT_VISION_COOLDOWN_SECONDS` | `20` | Minimum time between backtrack alerts |
| `MT_LOG_LEVEL` | `INFO` | Logging level |

See `config.py` for the full list.

## Develop

```bash
.venv/Scripts/python -m pytest          # unit + endpoint tests (no network, no screen needed)
.venv/Scripts/python -m ruff check .
.venv/Scripts/python -m ruff format .
.venv/Scripts/python export_contract.py # regenerate docs/contract/* after changing schemas.py
```

## Modules

| File | Responsibility |
|---|---|
| `main.py` | App factory, auth, error envelope, `/health`, sizing route, `/ws` |
| `ws.py` | WebSocket registry and broadcaster |
| `schemas.py` | All request/response/event models (contract source of truth) |
| `sizing.py` | Fixed cash, equity %, risk-to-stop formulas (Decimal) |
| `indicators.py` | pandas-ta engine and Lightweight Charts formatting |
| `vision.py` | mss capture, OpenCV chart reading, backtrack debouncer |
| `news_feed.py` | Finnhub client, cache, rate limiter, macro poller |
| `export_contract.py` | Generates `docs/contract/*.json` |

## Notes

* **pandas-ta** is no longer installable from PyPI; this project uses `pandas-ta-classic`, the
  maintained fork with the same API (`import pandas_ta_classic as ta`).
* **Finnhub economic calendar** requires a paid Finnhub plan. With a free key the calendar
  endpoint returns `402 finnhub_premium_required`, and news and sentiment keep working.
* **Privacy:** screen frames are processed in memory only and never stored or transmitted.
* **Memory:** measured on Windows 11 / Python 3.12: ~105 MB working set idle, ~119 MB after a
  5 000-candle `maison_core` compute (pandas + OpenCV dominate). The ~30 MB idle target applies
  to the Tauri shell, not this sidecar.
