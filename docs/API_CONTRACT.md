# Maison Terminal Core — API Contract

Contract for the frontend (`src/`) and Tauri shell (`src-tauri/`) to consume the Python
sidecar in `python-core/`.

| Artifact | Purpose |
|---|---|
| `docs/contract/openapi.json` | Full REST schema (OpenAPI 3). Generate TS types with `npx openapi-typescript docs/contract/openapi.json -o src/api/types.ts`. |
| `docs/contract/ws-events.schema.json` | WebSocket envelope and per-event `data` schemas. |
| `python-core/schemas.py` | Source of truth. Regenerate the JSON with `python export_contract.py`; a test fails if they drift. |

Live interactive docs while the sidecar runs: `http://127.0.0.1:8000/docs`.

---

## 1. Connection

| Item | Value |
|---|---|
| REST base URL | `http://127.0.0.1:8000` (override with `MT_HOST` / `MT_PORT`) |
| WebSocket URL | `ws://127.0.0.1:8000/ws` |
| Bind address | `127.0.0.1` only; never exposed to the network |
| Allowed browser origins | `tauri://localhost`, `http://tauri.localhost`, `https://tauri.localhost`, `http://localhost:1420`, `http://127.0.0.1:1420`, `http://localhost:5173` |
| Health probe | `GET /health` (no auth) — poll until `200` after spawning the sidecar |

### Authentication (optional, recommended in production)

If the Tauri shell launches the sidecar with `MT_AUTH_TOKEN=<random per-launch secret>`:

* REST: send `Authorization: Bearer <token>` on every `/api/v1/*` call.
* WebSocket: connect to `ws://127.0.0.1:8000/ws?token=<token>`.

Without the token: REST returns `401 unauthorized`; the WebSocket closes with code `1008`.
When `MT_AUTH_TOKEN` is unset, no auth is required.

### Error envelope (every non-2xx response)

```json
{ "error": { "code": "zero_stop_distance", "message": "stop_price must differ from entry_price", "details": null } }
```

Branch on `error.code`, never on `message`. Validation failures use `code: "validation_error"`
with Pydantic's error list in `details`.

| HTTP | Codes |
|---|---|
| 401 | `unauthorized` |
| 402 | `finnhub_premium_required` (endpoint needs a paid Finnhub plan) |
| 409 | `vision_not_configured` |
| 413 | `too_many_candles`, `image_too_large` |
| 422 | `validation_error`, `missing_field`, `zero_stop_distance`, `stop_on_wrong_side`, `ambiguous_risk_budget`, `unknown_indicator`, `unknown_indicator_param`, `indicator_failed`, `volume_required`, `no_indicators`, `too_many_indicators`, `invalid_candle_time`, `mixed_time_formats`, `duplicate_candle_time`, `not_enough_candles`, `invalid_image`, `invalid_date_range`, `invalid_category`, `invalid_symbol` |
| 500 | `internal_error` |
| 502 | `finnhub_unavailable`, `finnhub_unauthorized`, `finnhub_bad_response` |
| 503 | `finnhub_not_configured`, `finnhub_rate_limited` |

---

## 2. REST endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness + feature flags |
| POST | `/api/v1/sizing/calculate` | Position sizing (SizingDrawer) |
| GET | `/api/v1/indicators` | Indicator catalog |
| POST | `/api/v1/indicators/compute` | Indicator series for Lightweight Charts (ChartCanvas) |
| POST | `/api/v1/indicators/scan` | Multi-timeframe strategy scan |
| GET | `/api/v1/vision/monitors` | Screen layout for region picking |
| GET | `/api/v1/vision/status` | Chart-watch state |
| PUT | `/api/v1/vision/config` | Set capture region |
| POST | `/api/v1/vision/start` · `/stop` | Start/stop the chart watch loop |
| POST | `/api/v1/vision/check` | One-shot analysis (screen or uploaded image) |
| GET | `/api/v1/macro/calendar` | Economic calendar (CatalystFeed) |
| GET | `/api/v1/macro/news` | Market or company news with sentiment |
| GET | `/api/v1/macro/sentiment` | Aggregate sentiment for a symbol |

### 2.1 `GET /health`

```json
{
  "status": "ok", "service": "maison-terminal-core", "version": "0.1.0",
  "server_time": "2026-11-21T19:22:13.434755Z",
  "finnhub_configured": false, "vision_running": false, "websocket_clients": 0
}
```

Use `finnhub_configured` to show a "connect Finnhub" state in CatalystFeed.

### 2.2 `POST /api/v1/sizing/calculate`

Request fields (unknown fields are rejected):

| Field | Type | Used by mode | Notes |
|---|---|---|---|
| `mode` | `"fixed_cash" \| "equity_pct" \| "risk_to_stop"` | all | required |
| `entry_price` | number > 0 | all | required |
| `stop_price` | number > 0 | all (required for `risk_to_stop`) | side is inferred from it |
| `side` | `"long" \| "short"` | optional | rejected if it contradicts the stop |
| `account_equity` | number > 0 | `equity_pct`, `risk_to_stop` with `risk_pct` | also enables `%` metrics |
| `cash_amount` | number > 0 | `fixed_cash` | notional to deploy |
| `equity_pct` | 0 < n ≤ 100 | `equity_pct` | percent of equity to deploy |
| `risk_cash` | number > 0 | `risk_to_stop` | dollars lost at stop (exclusive with `risk_pct`) |
| `risk_pct` | 0 < n ≤ 100 | `risk_to_stop` | percent of equity lost at stop |
| `max_notional` | number > 0 | optional | buying-power cap |
| `allow_fractional` | bool (default `false`) | optional | |
| `lot_size` | number > 0 | optional | default `1`, or `0.0001` when fractional |
| `target_r_multiples` | number[] (default `[1,2,3]`) | optional | max 10 |

Formulas — shares are always **rounded down** to the lot step:

* `fixed_cash`: `shares = cash_amount / entry_price`
* `equity_pct`: `shares = account_equity × equity_pct / 100 / entry_price`
* `risk_to_stop`: `shares = risk_budget / |entry_price − stop_price|`, where
  `risk_budget = risk_cash` or `account_equity × risk_pct / 100`

Example:

```json
// request
{ "mode": "risk_to_stop", "entry_price": 100, "stop_price": 98, "account_equity": 50000, "risk_pct": 1 }
// response
{
  "mode": "risk_to_stop", "side": "long", "shares": 250.0,
  "entry_price": 100.0, "stop_price": 98.0, "notional": 25000.0,
  "stop_distance": 2.0, "stop_distance_pct": 2.0,
  "risk_amount": 500.0, "risk_pct_of_equity": 1.0, "notional_pct_of_equity": 50.0,
  "capped_by_max_notional": false,
  "targets": [ { "r_multiple": 1.0, "price": 102.0 }, { "r_multiple": 2.0, "price": 104.0 }, { "r_multiple": 3.0, "price": 106.0 } ],
  "warnings": []
}
```

`risk_amount`, `stop_distance*`, `targets` are `null`/empty when no stop is given;
`*_pct_of_equity` are `null` without `account_equity`. Show `warnings[]` verbatim (e.g. risk
above 2% of equity, leverage required, size rounds to zero).

### 2.3 Indicators

#### Candle input (shared)

```json
{ "time": 1763683200, "open": 101.2, "high": 102.9, "low": 100.8, "close": 102.4, "volume": 1250000 }
```

* `time` is **either** a UTC unix timestamp in **seconds** **or** a `"YYYY-MM-DD"` string —
  the same `Time` forms Lightweight Charts accepts. All candles in a request must use one form.
  The same values are echoed back unchanged.
* `volume` is optional; volume-based indicators (`obv`, `vwap`, `mfi`, …) require it on every candle.
* Candles may arrive unsorted (they are sorted); duplicate times are rejected.
* Limit: 20 000 candles and 32 indicators per request.

#### `GET /api/v1/indicators`

```json
{ "count": 206, "indicators": [
  { "name": "ema", "category": "overlap", "pane": "price", "inputs": ["close"], "params": ["length", "offset"] },
  { "name": "rsi", "category": "momentum", "pane": "oscillator", "inputs": ["close"], "params": ["length", "scalar", "drift", "offset"] }
] }
```

#### `POST /api/v1/indicators/compute`

```json
{
  "candles": [ /* Candle[] (≥ 2) */ ],
  "indicators": [ { "name": "ema", "params": { "length": 34 }, "id": "ema_fast" } ],
  "strategy": "maison_core",
  "include_candles": true
}
```

`strategy: "maison_core"` adds EMA 9/21/50/200, RSI 14, MACD 12/26/9 and Bollinger 20/2 (ids
`ema_9`, `ema_21`, `ema_50`, `ema_200`, `rsi_14`, `macd_12_26_9`, `bbands_20_2`) and enables
`summary`.

Response — every array is ready for `series.setData(...)`:

```json
{
  "candles": [ { "time": 1763683200, "open": 101.2, "high": 102.9, "low": 100.8, "close": 102.4 } ],
  "volume":  [ { "time": 1763683200, "value": 1250000 } ],
  "indicators": [
    {
      "id": "macd_12_26_9", "name": "macd", "params": { "fast": 12, "slow": 26, "signal": 9 },
      "pane": "oscillator",
      "reference_lines": [0.0],
      "series": [
        { "key": "MACD_12_26_9",  "style": "line",      "data": [ { "time": 1765843200, "value": 1.42 } ] },
        { "key": "MACDh_12_26_9", "style": "histogram", "data": [ { "time": 1765843200, "value": 0.31 } ] },
        { "key": "MACDs_12_26_9", "style": "line",      "data": [ { "time": 1765843200, "value": 1.11 } ] }
      ]
    }
  ],
  "summary": {
    "bias": "bullish", "score": 3, "last_close": 102.4, "last_time": 1763683200,
    "signals": [
      { "name": "ema_stack",    "bias": "bullish", "detail": "EMA 9 > 21 > 50 (bullish stack)" },
      { "name": "trend_filter", "bias": "bullish", "detail": "Close above EMA 200" },
      { "name": "rsi",          "bias": "neutral", "detail": "RSI 74.2 overbought (strong momentum, pullback risk)" },
      { "name": "macd",         "bias": "bullish", "detail": "MACD above signal (fresh cross)" },
      { "name": "bollinger",    "bias": "neutral", "detail": "Inside bands (%B 0.81)" }
    ]
  }
}
```

Rendering rules for `ChartCanvas.jsx`:

* `pane: "price"` → overlay on the candlestick pane; `pane: "oscillator"` → separate pane.
* `style: "line"` → `addLineSeries`; `style: "histogram"` → `addHistogramSeries` (colour by sign client-side).
* `reference_lines` → `series.createPriceLine({ price })` (RSI 30/70, MACD 0, …).
* Warm-up bars are **omitted**, not sent as `null`, so series may start later than candles.
* Bollinger produces `BBL_*`, `BBM_*`, `BBU_*` (bands) plus `BBB_*` (bandwidth) and `BBP_*` (%B);
  plot the first three on the price pane.
* `summary.score` is the sum of +1 bullish / −1 bearish signals; `bias` is bullish at ≥ +2,
  bearish at ≤ −2. RSI extremes and band breaks are cautions (`neutral`), not counter-votes.

#### `POST /api/v1/indicators/scan`

```json
// request
{ "timeframes": { "15m": [ /* Candle[] */ ], "1h": [ /* … */ ], "1D": [ /* … */ ] }, "strategy": "maison_core" }
// response
{
  "results": [ { "timeframe": "15m", "summary": { /* StrategySummary */ } } ],
  "confluence_bias": "bearish", "aligned_timeframes": 2, "total_timeframes": 3
}
```

1–8 timeframes. `confluence_bias` is the bias held by a strict majority, else `neutral`.

### 2.4 Vision (chart watch)

Region coordinates are **physical screen pixels** in virtual-desktop space (can be negative
for monitors left of / above the primary). Get the layout from `GET /api/v1/vision/monitors`:

```json
[ { "index": 0, "left": 0, "top": 0, "width": 2880, "height": 1800, "is_virtual_desktop": true },
  { "index": 1, "left": 0, "top": 0, "width": 2880, "height": 1800, "is_virtual_desktop": false } ]
```

Index 0 is the union of all monitors. If the UI works in CSS/logical pixels, multiply by
`window.devicePixelRatio` (Tauri: `scaleFactor`) before sending.

#### `PUT /api/v1/vision/config` → `VisionStatus`

```json
{
  "region": { "left": 120, "top": 160, "width": 1600, "height": 900 },
  "color_profile": "auto",
  "left_margin_pct": 0.05,
  "plot_bounds": null
}
```

* `color_profile`: `"auto"` (default) · `"green_red"` (coloured candles) · `"monochrome"` (hollow / black-white themes).
* `left_margin_pct` (0–0.3): width of the left-edge zone, default 5% of the plot.
* `plot_bounds`: optional manual plot rectangle relative to the region, if auto-detection of the
  axes fails for a broker.
* Region width/height must be 64–8192 px.

#### `POST /api/v1/vision/start` · `POST /api/v1/vision/stop` · `GET /api/v1/vision/status`

```json
{
  "running": true,
  "state": "backtrack_required",
  "config": { /* VisionConfig */ },
  "last_analysis": { /* VisionAnalysis */ },
  "last_error": null
}
```

`state`: `idle` (not running) · `no_chart` · `structure_visible` · `backtrack_required`.
`start` returns `409 vision_not_configured` until a config is set. The loop captures roughly every
0.75 s (`MT_VISION_INTERVAL_SECONDS`).

#### `POST /api/v1/vision/check` → `VisionAnalysis`

Stateless; never broadcasts. Body fields are all optional:
`image_base64` (PNG/JPEG, raw base64 or a `data:` URL, ≤ 40 MP), `color_profile`, `plot_bounds`.
Without an image the configured region is captured.

```json
{
  "captured_at": "2026-11-21T19:20:01.120Z",
  "image_width": 1600, "image_height": 900,
  "chart_bounds": { "x": 0, "y": 0, "width": 1440, "height": 820 },
  "data_left_x": 2,
  "data_coverage": 0.58,
  "swing_points": [ { "x": 412, "y": 96, "kind": "high" }, { "x": 690, "y": 702, "kind": "low" } ],
  "structure_truncated": true,
  "reasons": ["major_high_at_left_edge"],
  "confidence": 0.98
}
```

`reasons` values: `major_high_at_left_edge`, `major_low_at_left_edge`,
`insufficient_swing_structure` (fewer than 2 confirmed swing highs or lows), and
non-alert reasons `history_start_visible`, `structure_range_too_small`, `no_chart_detected`.
`swing_points` are in region pixels — usable for a debug overlay.

### 2.5 Macro & news (Finnhub)

All return `503 finnhub_not_configured` until `FINNHUB_API_KEY` is set.

> **Finnhub tiers:** the economic calendar requires a **paid** Finnhub plan; free keys get
> `402 finnhub_premium_required` — render a "calendar needs Finnhub premium" state. News works on
> the free plan. Symbol sentiment falls back to local headline scoring (`source: "lexicon"`).

#### `GET /api/v1/macro/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD&impact=high&country=US`

All params optional: range defaults to today → +7 days (max 31); `impact` is a **minimum**
(`low` | `medium` | `high`); `country` is a 2–3 letter code.

```json
{
  "from_date": "2026-11-21", "to_date": "2026-11-28", "count": 1, "cached": false,
  "events": [ {
    "id": "8c1d5f0e2a9b3c47", "time": "2026-11-21T13:30:00Z", "country": "US",
    "event": "CPI YoY", "impact": "high",
    "actual": null, "estimate": 3.1, "previous": 3.3, "unit": "%"
  } ]
}
```

Events are sorted by `time` (UTC). `actual` is `null` until released. `id` is stable for
de-duplication.

#### `GET /api/v1/macro/news?category=general&symbol=AAPL&limit=30`

`category`: `general` | `forex` | `crypto` | `merger`. With `symbol`, returns that company's last
7 days of news instead (and `category` is `null`). `limit` 1–100. Newest first.

```json
{
  "category": "general", "symbol": null, "count": 1, "cached": true,
  "items": [ {
    "id": 102, "published_at": "2026-11-21T18:01:40Z",
    "headline": "Bank warns of recession risk as profits plunge", "summary": "",
    "source": "Wire", "url": "https://…", "category": "general", "related": ["JPM"], "image": null,
    "sentiment": { "score": -0.8, "label": "bearish", "source": "lexicon" }
  } ]
}
```

#### `GET /api/v1/macro/sentiment?symbol=AAPL`

```json
{
  "symbol": "AAPL", "source": "finnhub",
  "bullish_pct": 70.0, "bearish_pct": 30.0,
  "score": 0.4, "label": "bullish", "articles_analysed": 42, "note": null
}
```

`score` ∈ [−1, 1]; `label` is `bullish` at ≥ 0.2, `bearish` at ≤ −0.2.

Caching: calendar 60 s, news 30 s (`cached: true` when served from cache). Upstream calls are
rate-limited to 55/min.

---

## 3. WebSocket

### Envelope (every server frame)

```ts
type WsEvent = {
  event: "HELLO" | "HEARTBEAT" | "PONG" | "ERROR" | "BACKTRACK_REQUIRED" | "BACKTRACK_CLEARED"
       | "VISION_STATUS" | "MACRO_EVENT_UPCOMING" | "NEWS_FLASH";
  message: string;     // always present, human readable
  ts: string;          // UTC ISO-8601, server send time
  data: object | null; // typed per event, see below
};
```

Ignore unknown `event` values and unknown fields — new ones may be added.

### Events

| `event` | When | `message` | `data` |
|---|---|---|---|
| `HELLO` | Immediately after connect | `"Maison Terminal core connected"` | `{ "version": "0.1.0" }` |
| `HEARTBEAT` | Every 20 s | `"alive"` | `null` |
| `PONG` | Reply to a client ping | `"pong"` | `null` |
| `ERROR` | Client sent an unsupported frame | explanation | `null` |
| `BACKTRACK_REQUIRED` | Chart watch confirmed truncated structure | **`"Historical Context Needed: Please scroll back on your trading chart"`** (fixed) | `BacktrackEventData` |
| `BACKTRACK_CLEARED` | Structure visible again after an alert | `"Chart structure visible"` (fixed) | `BacktrackEventData` |
| `VISION_STATUS` | Watch started / stopped / errored | `"Chart watch started"` · `"Chart watch stopped"` · `"Chart watch error"` | `{ "running": bool, "error": string \| null }` |
| `MACRO_EVENT_UPCOMING` | High-impact release ≤ 15 min away (once per release) | e.g. `"US CPI YoY in 10 min"` | `{ "event": EconomicEvent, "minutes_until": int }` |
| `NEWS_FLASH` | New general-news headline (≤ 5 per poll; none on start-up) | the headline | `{ "item": NewsItem }` |

`BacktrackEventData`:

```json
{
  "reasons": ["major_high_at_left_edge"],
  "confidence": 0.98,
  "data_left_x": 2,
  "chart_bounds": { "x": 0, "y": 0, "width": 1440, "height": 820 }
}
```

Example frame:

```json
{
  "event": "BACKTRACK_REQUIRED",
  "message": "Historical Context Needed: Please scroll back on your trading chart",
  "ts": "2026-11-21T19:20:03.512Z",
  "data": { "reasons": ["major_high_at_left_edge"], "confidence": 0.98, "data_left_x": 2,
            "chart_bounds": { "x": 0, "y": 0, "width": 1440, "height": 820 } }
}
```

`BacktrackPrompt.jsx`: show the banner on `BACKTRACK_REQUIRED`, hide it on `BACKTRACK_CLEARED`.
The server debounces (3 consecutive frames to raise or clear, 20 s cooldown between alerts) and
ignores frames where no chart is visible, so no client-side debouncing is needed.

### Client → server

```json
{ "action": "ping" }
```

Answered with `PONG`. Any other frame gets an `ERROR` event (the connection stays open).

### Reconnection

The sidecar may restart. Reconnect with backoff (e.g. 0.5 s → 8 s). Treat a missing
`HEARTBEAT` for > 45 s as a dead connection. On reconnect, call `GET /api/v1/vision/status` to
resync the banner state, since transition events are not replayed.
