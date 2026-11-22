/**
 * Connection settings for the local analytical service (python-core).
 *
 * The service binds to 127.0.0.1:8000. We use the IPv4 loopback literal rather than
 * "localhost" because Windows may resolve "localhost" to ::1 first, which the service does
 * not listen on. VITE_ENGINE_URL may override the base URL; it is a non-secret address.
 * Provider credentials (Finnhub) live only in the Python service, never in this bundle.
 */

const DEFAULT_ENGINE_HTTP_URL = 'http://127.0.0.1:8000'

function normalizeBaseUrl(rawUrl) {
  return rawUrl.trim().replace(/\/+$/, '')
}

export const ENGINE_HTTP_URL = normalizeBaseUrl(
  import.meta.env.VITE_ENGINE_URL || DEFAULT_ENGINE_HTTP_URL,
)

export function buildWebSocketUrl(httpBaseUrl = ENGINE_HTTP_URL) {
  const socketUrl = new URL('/ws', httpBaseUrl)
  socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  return socketUrl.toString()
}

export const ENGINE_SOCKET_URL = buildWebSocketUrl()

/** Exact command to start the service by hand (browser preview / development). */
export const ENGINE_START_COMMAND = 'cd python-core && .venv\\Scripts\\python main.py'

/** Where the desktop app writes the bundled engine's output (Tauri app_log_dir on Windows). */
export const ENGINE_LOG_LOCATION = '%LOCALAPPDATA%\\com.maisonterminal.desktop\\logs\\maison-core.log'

/**
 * Screen-read candles (GET /api/v1/vision/candles) use placeholder times one minute apart
 * from this origin and a relative price scale from 100 (chart bottom) to 200 (chart top).
 */
export const SCREEN_TIME_ORIGIN = 1_700_000_000
export const SCREEN_BAR_SECONDS = 60
export const RELATIVE_SCALE_FLOOR = 100

/** A fresh launch shows "Starting engine…" (not "offline") while the bundled engine boots. */
export const ENGINE_STARTUP_GRACE_MS = 25_000

/** The service's indicator compute endpoint accepts at most this many candles. */
export const MAX_CANDLES_PER_REQUEST = 20_000

/** Calendar is cached for 60 s by the service, so polling faster gains nothing. */
export const CALENDAR_REFRESH_INTERVAL_MS = 60_000
