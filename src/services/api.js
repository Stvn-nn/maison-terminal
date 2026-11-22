/**
 * Shared REST client for the local analytical service (python-core, FastAPI).
 *
 * Components never build route strings: they call the named functions below. Every
 * failure becomes an EngineError carrying the service's machine-readable `code`
 * (see the service's `{ "error": { code, message, details } }` envelope), or
 * `engine_unreachable` when the service is not running.
 */

import { ENGINE_HTTP_URL } from '../config.js'
import { normalizeSeriesPoints, sortAndDeduplicateByTime } from '../lib/candles.js'

const DEFAULT_TIMEOUT_MS = 10_000
const COMPUTE_TIMEOUT_MS = 30_000

export class EngineError extends Error {
  constructor({ code, message, status = null, details = null, isNetworkError = false }) {
    super(message)
    this.name = 'EngineError'
    this.code = code
    this.status = status
    this.details = details
    this.isNetworkError = isNetworkError
  }

  /** Worth retrying automatically or via a Retry button (vs. a fix-your-input error). */
  get isRecoverable() {
    return this.isNetworkError || this.status === null || this.status >= 500
  }
}

function buildUrl(path, queryParameters) {
  const requestUrl = new URL(path, `${ENGINE_HTTP_URL}/`)
  for (const [parameterName, parameterValue] of Object.entries(queryParameters ?? {})) {
    if (parameterValue !== undefined && parameterValue !== null && parameterValue !== '') {
      requestUrl.searchParams.set(parameterName, String(parameterValue))
    }
  }
  return requestUrl
}

async function readErrorEnvelope(response) {
  try {
    const responseBody = await response.json()
    if (responseBody && typeof responseBody.error === 'object' && responseBody.error !== null) {
      return responseBody.error
    }
  } catch {
    // Non-JSON error body; fall through to a generic HTTP error.
  }
  return null
}

/**
 * Perform a JSON request against the service.
 * @param {string} path e.g. "/api/v1/sizing/calculate"
 * @param {{method?: string, body?: unknown, query?: Record<string, unknown>,
 *          signal?: AbortSignal, timeoutMs?: number}} options
 */
export async function requestJson(path, options = {}) {
  const { method = 'GET', body, query, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = options
  const timeoutController = new AbortController()
  const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs)
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal

  let response
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: combinedSignal,
    })
  } catch (transportError) {
    if (signal?.aborted) throw transportError // caller cancelled; let AbortError propagate
    if (timeoutController.signal.aborted) {
      throw new EngineError({
        code: 'request_timeout',
        message: 'The analytical service did not respond in time',
        isNetworkError: true,
      })
    }
    throw new EngineError({
      code: 'engine_unreachable',
      message: 'The analytical service is not reachable on this machine',
      isNetworkError: true,
    })
  } finally {
    clearTimeout(timeoutHandle)
  }

  if (!response.ok) {
    const errorEnvelope = await readErrorEnvelope(response)
    throw new EngineError({
      code: errorEnvelope?.code ?? `http_${response.status}`,
      message: errorEnvelope?.message ?? `The analytical service returned HTTP ${response.status}`,
      status: response.status,
      details: errorEnvelope?.details ?? null,
    })
  }
  return response.json()
}

export function isAbortError(error) {
  return error?.name === 'AbortError'
}

// --------------------------------------------------------------------------------------
// Payload normalisation (client boundary)
// --------------------------------------------------------------------------------------

/** Calendar events: parse UTC ISO strings into Dates and order by actual release time. */
export function normalizeCalendarResponse(responseBody) {
  const rawEvents = Array.isArray(responseBody?.events) ? responseBody.events : []
  const events = rawEvents
    .map((rawEvent) => ({ ...rawEvent, releaseTime: new Date(rawEvent.time) }))
    .filter((event) => !Number.isNaN(event.releaseTime.getTime()))
    .sort((firstEvent, secondEvent) => firstEvent.releaseTime - secondEvent.releaseTime)
  return {
    fromDate: responseBody?.from_date ?? null,
    toDate: responseBody?.to_date ?? null,
    servedFromCache: Boolean(responseBody?.cached),
    events,
  }
}

/** Indicator response: sort/deduplicate every series and drop non-finite points. */
export function normalizeIndicatorResponse(responseBody) {
  const candles = sortAndDeduplicateByTime(
    (responseBody?.candles ?? []).filter((candle) =>
      ['open', 'high', 'low', 'close'].every((field) => Number.isFinite(candle?.[field])),
    ),
  )
  const volume = responseBody?.volume ? normalizeSeriesPoints(responseBody.volume) : null
  const indicators = (responseBody?.indicators ?? []).map((indicator) => ({
    ...indicator,
    series: (indicator.series ?? []).map((series) => ({
      ...series,
      data: normalizeSeriesPoints(series.data ?? []),
    })),
  }))
  return { candles, volume, indicators, summary: responseBody?.summary ?? null }
}

// --------------------------------------------------------------------------------------
// Endpoints (verified against the running service's OpenAPI schema)
// --------------------------------------------------------------------------------------

export const engineApi = {
  getHealth({ signal } = {}) {
    return requestJson('/health', { signal, timeoutMs: 3_000 })
  },

  async getEconomicCalendar({ fromDate, toDate, minimumImpact, country, signal } = {}) {
    const responseBody = await requestJson('/api/v1/macro/calendar', {
      query: { from: fromDate, to: toDate, impact: minimumImpact, country },
      signal,
    })
    return normalizeCalendarResponse(responseBody)
  },

  async computeIndicators({ candles, strategy = 'maison_core', indicators = [], signal }) {
    const responseBody = await requestJson('/api/v1/indicators/compute', {
      method: 'POST',
      body: { candles, strategy, indicators, include_candles: true },
      signal,
      timeoutMs: COMPUTE_TIMEOUT_MS,
    })
    return normalizeIndicatorResponse(responseBody)
  },

  calculatePositionSize(sizingRequest, { signal } = {}) {
    return requestJson('/api/v1/sizing/calculate', {
      method: 'POST',
      body: sizingRequest,
      signal,
    })
  },

  getVisionStatus({ signal } = {}) {
    return requestJson('/api/v1/vision/status', { signal, timeoutMs: 3_000 })
  },

  /** Ask the engine to find a chart on screen (ignoring `excludeRegions`) and watch it. */
  scanForChart({ excludeRegions = [], startWatch = true, signal } = {}) {
    return requestJson('/api/v1/vision/scan', {
      method: 'POST',
      body: { exclude_regions: excludeRegions, start_watch: startWatch },
      signal,
      timeoutMs: 15_000,
    })
  },

  stopChartWatch({ signal } = {}) {
    return requestJson('/api/v1/vision/stop', { method: 'POST', signal, timeoutMs: 5_000 })
  },

  /** News sentiment for a symbol (Finnhub, or the engine's headline scoring fallback). */
  getSymbolSentiment(symbol, { signal } = {}) {
    return requestJson('/api/v1/macro/sentiment', { query: { symbol }, signal })
  },

  /** Candles read from the watched screen region (relative scale, placeholder times). */
  getScreenCandles({ signal } = {}) {
    return requestJson('/api/v1/vision/candles', { signal, timeoutMs: 5_000 })
  },

  /** Type-ahead symbol suggestions (stocks, ETFs, indices, forex, crypto, futures). */
  searchSymbols(query, { signal } = {}) {
    return requestJson('/api/v1/market/search', { query: { q: query }, signal, timeoutMs: 8_000 })
  },

  /** Real OHLC bars for a symbol at a timeframe (1m, 5m, 15m, 30m, 1h, 1d, 1w, 1M). */
  getMarketCandles({ symbol, timeframe, signal }) {
    return requestJson('/api/v1/market/candles', {
      query: { symbol, interval: timeframe },
      signal,
      timeoutMs: 12_000,
    })
  },
}
