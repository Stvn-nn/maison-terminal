<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
    <img src="docs/assets/wordmark-light.svg" alt="Maison Terminal" width="420">
  </picture>
</h1>

<p align="center">
  <a href="https://github.com/Stvn-nn/maison-terminal/releases/download/v0.1.0/Maison-Terminal_0.1.0_x64-setup.exe"><strong>⬇ Download the Windows installer (v0.1.0, 64 MB)</strong></a>
  <br>
  <sub>Windows 10/11 (64-bit) · per-user installer, no admin rights · analytical engine included, no Python needed</sub>
  <br>
  <sub><a href="https://github.com/Stvn-nn/maison-terminal/releases/tag/v0.1.0">Release notes</a> · <a href="https://github.com/Stvn-nn/maison-terminal/releases">All releases</a></sub>
</p>

<p align="center">
  <img src="docs/assets/app-icon.png" alt="Maison Terminal app icon: white MT monogram on black" width="72">
</p>

Maison Terminal is a Windows desktop workspace for traders. The chart is the main canvas,
with Python-computed indicators on it. Around it sit a strip of upcoming macro releases, a
position-sizing drawer, and a screen-vision "chart watch" that tells you when your broker
chart has scrolled past the swing structure you need to see.

Everything runs on your machine. The desktop app bundles its own analytical engine (Python,
packaged into a standalone program) and starts it when you open the app.

---

## Contents

- [Download and install](#download-and-install)
- [What it does](#what-it-does)
- [Using the app](#using-the-app)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [How it is built](#how-it-is-built)
- [Development](#development)
- [Building the installer](#building-the-installer)
- [Known limitations](#known-limitations)
- [Third-party notices](#third-party-notices)

---

## Download and install

1. [Download **`Maison-Terminal_0.1.0_x64-setup.exe`**](https://github.com/Stvn-nn/maison-terminal/releases/download/v0.1.0/Maison-Terminal_0.1.0_x64-setup.exe)
   from the [v0.1.0 release](https://github.com/Stvn-nn/maison-terminal/releases/tag/v0.1.0).
   No GitHub account is needed. SHA-256:
   `9378b379b3fb4619b2403836c848dd0f468dfa8802078d7bc1aee48b33f60222`.
   Newer versions will appear under [Releases](https://github.com/Stvn-nn/maison-terminal/releases).
2. Run the installer. It installs for your Windows user only, with no administrator rights.
3. Open **Maison Terminal** from the Start menu. The title bar shows **Starting engine…**,
   then **Engine connected** a few seconds later.
4. To pin it: **right-click Maison Terminal on the taskbar → Pin to taskbar**. (Windows does
   not let apps pin themselves.)

> **The installer is not code-signed yet.** Windows SmartScreen may show "Windows protected
> your PC". Choose **More info → Run anyway**. On PCs with **Smart App Control** turned on,
> Windows blocks unsigned apps entirely. On those PCs, use the [browser preview](#development)
> or wait for a signed build.

To uninstall, use **Settings → Apps → Installed apps → Maison Terminal → Uninstall**.

---

## What it does

| Area | What you get |
|---|---|
| **Chart** | Two sources: **Screen** (default) reads the candles straight off your broker chart, no file needed; **CSV file** loads real prices from a broker export. Shows candles, EMA 9/21/50/200, Bollinger Bands, and RSI and MACD in their own panes, all computed by the engine (pandas-ta). A line under the chart always says where the data came from. |
| **Python signal** | A combined reading (bullish / bearish / neutral) from five checks. Click it to see what each check found, what it measures, how the score works, and what the reading means for risk. |
| **Catalyst strip** | Upcoming economic releases from Finnhub, ordered by time and shown in your local time zone. Each has an impact dot (red = high, orange = medium, yellow = low), estimate / previous / actual where available, and a live countdown. Filter by **Impact**: High, Med+ or All. |
| **Sizing drawer** | Position sizing in three modes. **Risk to stop**: size so hitting your stop loses a set % of equity or a fixed $ amount. **% of equity**: deploy a percentage of your account. **Fixed cash**: deploy a dollar amount. Shows shares, max dollar risk, notional, risk as % of equity, stop distance, 1R/2R/3R targets and warnings, plus a **What this means** section that explains the risk in plain words. |
| **Chart watch** | Starts automatically: the app finds your broker chart on screen (ignoring its own window) and watches it, re-scanning if you move it. When the major swing high or low sits at the left edge, or too few swings are visible, a banner says *"Historical Context Needed: Please scroll back on your trading chart."* The banner hides itself once structure is visible again. |
| **Status** | The title bar shows engine connection state and chart-watch state. If the engine drops, panels keep their last data marked as stale and reconnect automatically. |

---

## Using the app

### See your chart (no setup)

1. Open your broker chart (for example TradingView in your browser) **beside** Maison Terminal,
   so both are visible. Charts with green and red candles work best.
2. That's it. Within a few seconds the title bar says **Watching your chart**, and with the
   chart **Source** set to **Screen** the chart area mirrors your broker chart's candles with
   the indicators on top.

The screen shows each candle's shape but not its price labels, so the screen chart uses a
**relative scale**: 0 is the bottom of your chart and 100 the top, with bars numbered left to
right. Trend and momentum readings (EMA crossovers, RSI, MACD, Bollinger %B) don't depend on
the price scale, so they match what real prices would give. Click the eye icon in the title
bar to stop or restart the chart watch.

### Load real prices from a file (optional)

For actual prices, switch **Source** to **CSV file** and load your broker's export:

1. Click **Open CSV export…** in the chart area.
2. Pick a CSV with a header row containing `time`, `open`, `high`, `low`, `close`, and
   optionally `volume`. Column names are case-insensitive; `date` and `datetime` also work
   for `time`.
3. The engine computes the indicators, and the chart fits the data.

Accepted time formats: daily dates (`2026-01-05`), unix timestamps in seconds or
milliseconds, and ISO date-times (`2026-01-05 14:30:00`; times without an offset are read as
UTC). Rows are sorted and duplicate times removed. Up to 20,000 bars are used (the most recent
ones).

### Size a position

Open the drawer on the right (click **Sizing** if it is collapsed), choose a **Sizing mode**,
fill in the fields and press **Calculate**.

- Percentages are plain numbers: type `1` for 1%.
- **Direction → Auto** works out long or short from where your stop sits.
- If you change any input after calculating, the old result is dimmed and marked as belonging
  to the previous inputs.
- Errors from the engine (for example a stop on the wrong side of entry) appear under the field
  they belong to.
- **What this means** explains the result: what you lose if the stop is hit (and as a share of
  your account), the position's value, what each R target would gain, and how the risk compares
  with the common 1–2% rule of thumb. It's a sizing aid, not financial advice.

### Where the data comes from

Every panel says where its data came from:

| Panel | Source shown |
|---|---|
| Chart | "Candles read from your screen (region, time)" or "Prices from your-file.csv", plus when the engine computed the indicators |
| Python signal | The same chart source, and that the engine computed it with pandas-ta |
| Catalyst strip | Finnhub, fetched by the engine, with the last update time |
| Sizing drawer | "Calculated by the Maison engine from the numbers you entered", with the time |

The window can be resized down to 420×320; on narrow windows the sizing drawer floats over the
chart instead of squeezing it.

---

## Configuration

The bundled engine reads settings from a `.env` file in the app's config folder:

```
%APPDATA%\com.maisonterminal.desktop\.env
```

| Setting | Purpose |
|---|---|
| `FINNHUB_API_KEY=...` | Enables the catalyst strip and news. The economic calendar needs a **paid** Finnhub plan; with a free key the strip explains that the calendar is unavailable. |
| `MT_MACRO_ALERT_LEAD_MINUTES=15` | How early to announce upcoming high-impact releases. |
| `MT_VISION_INTERVAL_SECONDS=0.75` | How often the chart watch captures the screen. |
| `MT_VISION_CONFIRM_FRAMES=3` | Frames needed before the backtrack banner appears or clears. |

Restart the app after editing `.env`. The full list is in
[`python-core/config.py`](python-core/config.py) (variables use the `MT_` prefix).

**Privacy:** screen captures are analysed in memory and never saved or sent anywhere. The
Finnhub key stays in the engine and is never sent to the desktop UI.

---

## Troubleshooting

| Symptom | What to do |
|---|---|
| Title bar stays on **Engine offline** | Check the engine log at `%LOCALAPPDATA%\com.maisonterminal.desktop\logs\maison-core.log`. Another program may be using port 8000. |
| Windows blocks the installer or app | It is unsigned. See the note under [Download and install](#download-and-install). |
| Catalyst strip says **Feed unavailable** | The reason is shown next to it: no Finnhub key, a free plan (the calendar needs a paid plan), or Finnhub unreachable. |
| Chart says **Couldn't load the chart** | The message names the problem, for example a missing column or the row the engine rejected. Fix the file and open it again. |
| Title bar says **No chart on screen** | Put your broker chart beside Maison Terminal so both are visible (not behind it or minimised), with green/red candles. It re-checks every few seconds; click **Scan now** in the chart area to check immediately. |
| Chart watch never shows a banner | The banner only appears when the structure is cut off at the left edge. Check that the title bar says **Watching your chart**. |
| Engine already running separately | The app detects a healthy engine on port 8000 and uses it instead of starting its own. |

---

## How it is built

```
maison-terminal/
├── src/                    React 19 + Vite workspace (JSX, Tailwind CSS 4)
│   ├── components/         ChartCanvas, SizingDrawer, CatalystFeed, BacktrackPrompt, TitleBar, …
│   ├── hooks/              Engine connection, calendar, sizing, indicators, native window
│   ├── services/           REST client and the single WebSocket connection owner
│   └── lib/                CSV parsing, sizing form mapping, formatting
├── src-tauri/              Tauri v2 shell (Rust): window, icons, engine lifecycle
│   └── src/engine.rs       Starts/reuses/stops the bundled engine
├── python-core/            Analytical engine: FastAPI + WebSocket on 127.0.0.1:8000
│   ├── indicators.py       pandas-ta strategy engine
│   ├── vision.py           Screen capture (mss) and OpenCV chart reading
│   ├── news_feed.py        Finnhub calendar, news and sentiment
│   └── sizing.py           Position sizing formulas (Decimal)
├── scripts/build-engine.ps1   Packages python-core with PyInstaller
└── .github/workflows/         Builds the self-contained Windows installer
```

| Layer | Technology |
|---|---|
| Desktop shell | Tauri v2 (Rust), frameless window with a custom title bar |
| Interface | React 19, Vite 8, Tailwind CSS 4, TradingView Lightweight Charts 5, lucide icons |
| Engine | Python 3.12, FastAPI, uvicorn, pandas-ta-classic, OpenCV, mss, httpx |
| Packaging | PyInstaller (engine), NSIS (installer), GitHub Actions (Windows build) |

The interface talks to the engine over HTTP (`http://127.0.0.1:8000/api/v1/…`) and one
WebSocket (`ws://127.0.0.1:8000/ws`) for live events. More detail:

- [docs/DESKTOP.md](docs/DESKTOP.md): desktop app, engine lifecycle, security, smoke test
- [docs/API_CONTRACT.md](docs/API_CONTRACT.md): every REST endpoint and WebSocket event
- [python-core/README.md](python-core/README.md): engine setup and configuration
- [ARCHITECTURE.md](ARCHITECTURE.md): original target layout

---

## Development

**Prerequisites:** Windows 10/11, Node.js 20+, Python 3.11–3.13. Rust with the MSVC build
tools is only needed to run the native window (`tauri dev`) or build the installer locally.

**1. Install dependencies** (once):

```powershell
npm install
```

```powershell
cd python-core; py -3.12 -m venv .venv; .venv\Scripts\python -m pip install -r requirements-dev.txt; cd ..
```

**2. Start the engine** (keep this terminal open):

```powershell
cd python-core; .venv\Scripts\python main.py
```

**3. Start the interface**, in a second terminal. Either open the native window:

```powershell
npm run tauri dev
```

or use the **browser preview** and open http://localhost:1420:

```powershell
npm run dev
```

The interface uses port 1420 (on the engine's CORS allow-list) and the engine uses port 8000.
In development nothing is bundled, so the app connects to the engine you started.

### Checks

```powershell
npm run lint
```

```powershell
npm test
```

```powershell
cd python-core; .venv\Scripts\python -m pytest; .venv\Scripts\python -m ruff check .; cd ..
```

---

## Building the installer

**In CI (recommended).** The
[Desktop installer (Windows)](https://github.com/Stvn-nn/maison-terminal/actions/workflows/desktop-installer.yml)
workflow runs on every push to `main` or a feature branch, on pull requests, or on demand
(**Run workflow**). It tests the engine, packages it, smoke-tests the packaged engine, runs
the interface's lint and tests, and builds the installer with the engine inside. Download the
latest build:

```powershell
gh run download --name maison-terminal-windows-installer --dir installer
```

**Locally** (needs the MSVC build tools; machines with Smart App Control enforced block local
Rust builds):

```powershell
python -m pip install -r python-core/requirements.txt pyinstaller
```

```powershell
./scripts/build-engine.ps1
```

```powershell
npm run tauri build -- --config src-tauri/tauri.engine.conf.json
```

The installer is written to `src-tauri/target/release/bundle/nsis/`.

---

## Known limitations

- **No price feed.** The Screen source shows candle shapes on a relative scale (no price
  labels are read); real prices need a CSV export.
- **Screen reading needs coloured candles.** Hollow or single-colour candle styles can be
  watched for backtrack alerts but their candles are not read yet.
- **Your chart must be visible.** The chart watch reads what is on screen, so a chart hidden
  behind Maison Terminal or minimised can't be seen.
- **Economic calendar needs a paid Finnhub plan.** News works with a free key.
- **Unsigned installer.** Code signing is needed to avoid SmartScreen and Smart App Control
  blocks.
- **Windows only** for the packaged app.

---

## Third-party notices

- Charts by **TradingView Lightweight Charts™** (Apache-2.0). The TradingView attribution
  logo stays on the chart as its licence requires.
- Fonts: **Cormorant Garamond** and **Inter**, both under the SIL Open Font License.
- Economic calendar and news data come from **Finnhub** under your own API key and its terms.
- Technical indicators by **pandas-ta-classic**; screen capture by **mss**; image processing
  by **OpenCV**.

Maison Terminal provides analysis tools only. Nothing in the app is financial advice.
