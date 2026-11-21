# Maison Terminal Architecture

```text
maison-terminal/
├── src-tauri/                      # Tauri Desktop Configuration (Rust)
│   ├── tauri.conf.json             # Window size, taskbar pin, system tray, sidecar config
│   └── src/main.rs                 # Application lifecycle
├── src/                            # Desktop Frontend (React + Vite + Tailwind)
│   ├── components/
│   │   ├── ChartCanvas.jsx         # TradingView Lightweight Charts canvas
│   │   ├── SizingDrawer.jsx        # Cash / % equity / risk-to-stop calculator
│   │   ├── CatalystFeed.jsx        # Finnhub economic calendar & live sentiment
│   │   └── BacktrackPrompt.jsx     # Floating visual banner ("Scroll back on chart")
│   ├── App.jsx                     # Maison Terminal dashboard layout
│   └── index.css                   # Obsidian / bone-white luxury dark theme
└── python-core/                    # Analytical Sidecar Backend (FastAPI)
    ├── main.py                     # FastAPI server & WebSocket broadcaster
    ├── indicators.py               # Pandas-TA strategy engine
    ├── vision.py                   # MSS screen grabber & backtrack check
    ├── news_feed.py                # Finnhub calendar & news endpoints
    ├── sizing.py                   # Position sizing & risk formulas
    └── requirements.txt
