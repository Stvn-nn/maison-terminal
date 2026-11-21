# Maison Terminal — Desktop App

The Windows desktop workspace for the Maison Terminal analytical service: a dominant chart,
a macro-catalyst strip, a position-sizing drawer and screen-vision alerts.

**Stack:** Tauri v2 (Rust shell) · React 19 + Vite 8 (JSX) · Tailwind CSS 4 ·
TradingView Lightweight Charts 5.

```
src/
  components/   ChartCanvas.jsx, SizingDrawer.jsx, CatalystFeed.jsx, BacktrackPrompt.jsx, TitleBar.jsx
  hooks/        useTerminalSocket, useEconomicCalendar, usePositionSizing, useIndicatorWorkspace,
                useVisionStatus, useNativeWindow
  services/     api.js (REST client), terminalSocket.js (single WebSocket owner)
  lib/          candles.js (CSV boundary), sizingForm.js, backtrackAlert.js, format.js
src-tauri/      Tauri v2 shell (window only), capabilities, icons, NSIS bundle config
```

## How the pieces fit

| Concern | Owner |
|---|---|
| Window, title bar, taskbar identity | Tauri shell (`src-tauri/`) |
| Indicators, calendar, sizing, screen vision | Python service (`python-core/`, port 8000) |
| Python process lifecycle | **You** — the service runs on its own; the app never starts or stops it |

The app connects to `http://127.0.0.1:8000` and `ws://127.0.0.1:8000/ws`. If the service is
not running, the title bar shows **Engine offline · retry in Ns**, data panels keep their last
good values marked as stale, and everything recovers automatically once the service starts —
no app restart needed. `127.0.0.1` is used instead of `localhost` because Windows can resolve
`localhost` to IPv6 `::1`, which the service does not listen on.

## Verified backend contract

| Feature | Endpoint / channel | Notes |
|---|---|---|
| Chart indicators | `POST /api/v1/indicators/compute` (`strategy: "maison_core"`) | Candle `time` is unix **seconds** or `"YYYY-MM-DD"`; warm-up points are omitted; 20 000-candle cap |
| Chart price history | **none** | The service has no price-history or live-price endpoint. The chart loads a broker CSV export you choose and plots what Python computes for it. |
| Macro calendar | `GET /api/v1/macro/calendar?impact=` | UTC times, shown in your local zone (labelled). Needs `FINNHUB_API_KEY` on the service and a paid Finnhub plan; otherwise the strip shows *Feed unavailable* with the reason. Polled every 60 s (the service's cache lifetime). |
| Sizing | `POST /api/v1/sizing/calculate` | Percentages are **percentage points** (2% is sent as `2`). Modes: `risk_to_stop`, `equity_pct`, `fixed_cash`. Python is the sole sizing authority. |
| Screen vision | `ws://…/ws` — no subscription message | `BACKTRACK_REQUIRED` shows the banner; the documented `BACKTRACK_CLEARED` hides it. Dismissing is local only (the service defines no acknowledgement). |
| Chart-watch state | `GET /api/v1/vision/status` + `VISION_STATUS` events | Alerts only arrive after the watch is configured and started on the service (`PUT /api/v1/vision/config`, `POST /api/v1/vision/start`); the desktop UI does not yet expose region selection. |

Full service contract: `docs/API_CONTRACT.md` on the `feature/backend-core` branch.

## Prerequisites

- Windows 10/11 with WebView2 (built into Windows 11)
- Node.js 20+ and npm
- Rust (stable, 1.90+) with the MSVC toolchain — only for `tauri dev` / `tauri build`
- The Python service from `python-core/` (Python 3.11–3.13)

## Run

**1. Start the Python service** (separate terminal, from the repository root):

```bash
cd python-core
.venv\Scripts\python main.py
```

First-time setup of the service: `py -3.12 -m venv .venv` then
`.venv\Scripts\python -m pip install -r requirements.txt` (see `python-core/README.md`).

**2. Start the desktop app in development:**

```bash
npm install
npm run tauri dev
```

**Browser preview** (no native window; the title bar shows *Browser preview* and hides the
window controls):

```bash
npm run build
npm run preview
```

Both dev and preview use port **1420**, which is on the service's CORS allow-list. Port 8000
stays reserved for Python.

## Checks

```bash
npm run lint
npm test
npm run build
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings
```

## Release build and install

```bash
npm run tauri build
```

The installer is written to:

```
src-tauri/target/release/bundle/nsis/Maison Terminal_0.1.0_x64-setup.exe
```

It is a per-user NSIS installer (no administrator rights). It adds **Maison Terminal** to the
Start menu with the gold "M" icon. Identity: product name `Maison Terminal`, bundle identifier
`com.maisonterminal.desktop`.

### Pin to the taskbar

Windows does not allow apps to pin themselves. After installing:

1. Launch **Maison Terminal** from the Start menu.
2. **Right-click Maison Terminal on the taskbar → Pin to taskbar.**
3. Close the app; click the pinned icon to relaunch it.

### Windows smoke test

1. Start the Python service (command above).
2. Run the installer; launch Maison Terminal from Start.
3. Title bar shows **Engine connected**; catalyst strip shows releases or a labelled
   *Feed unavailable* reason.
4. Pin it (steps above), close it, relaunch from the pinned icon — same icon, same window,
   **Engine connected** again.
5. Stop the service: the title bar changes to **Engine offline**. Start it again: it
   reconnects without restarting the app.
6. Drag the title bar; use minimize, maximize/restore (also double-click the title bar) and
   close; resize to the minimum size and confirm the drawer is reachable.

## Security notes

- Release CSP (`src-tauri/tauri.conf.json` → `app.security.csp`) allows network access only to
  the loopback service (`127.0.0.1:8000` / `localhost:8000`, HTTP and WS) plus Tauri IPC.
  Vite dev-server allowances live only in `devCsp`.
- The service's CORS policy already allows the packaged origin `http://tauri.localhost` and the
  dev origin `http://localhost:1420`; no backend change was needed.
- No credentials are bundled. Finnhub keys stay in the Python service's environment.
- `VITE_ENGINE_URL` can point the app at a different service address at build time; update the
  CSP `connect-src` to match.
- The main window holds only the window permissions the title bar uses
  (`src-tauri/capabilities/default.json`).

## Third-party notice

Charts are rendered with **TradingView Lightweight Charts™** (Apache-2.0). The TradingView
attribution logo is kept on the chart as its licence requires
(https://www.tradingview.com/lightweight-charts/).
