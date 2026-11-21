# maison-terminal

Maison Terminal is a Windows-first financial desktop app: a chart workspace, macro catalysts,
position sizing and screen-vision alerts, backed by a local Python analytical service.

- **Desktop app** (Tauri v2 + React): see [docs/DESKTOP.md](docs/DESKTOP.md) for startup,
  release build, installation and taskbar pinning.
- **Analytical service** (`python-core/`, FastAPI on `127.0.0.1:8000`): see
  `python-core/README.md` and `docs/API_CONTRACT.md`.
- **Architecture**: [ARCHITECTURE.md](ARCHITECTURE.md).
