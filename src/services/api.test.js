import { afterEach, describe, expect, it, vi } from 'vitest'

import { EngineError, engineApi, normalizeCalendarResponse, normalizeIndicatorResponse, requestJson } from './api.js'

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('requestJson', () => {
  it('raises the service error code from the error envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: { code: 'finnhub_not_configured', message: 'Set FINNHUB_API_KEY', details: null } }, 503),
      ),
    )
    const requestPromise = requestJson('/api/v1/macro/calendar')
    await expect(requestPromise).rejects.toBeInstanceOf(EngineError)
    await expect(requestJson('/api/v1/macro/calendar')).rejects.toMatchObject({
      code: 'finnhub_not_configured',
      status: 503,
      isRecoverable: true,
    })
  })

  it('reports an unreachable service distinctly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    await expect(requestJson('/health')).rejects.toMatchObject({ code: 'engine_unreachable', isNetworkError: true })
  })

  it('targets the IPv4 loopback service and sends JSON bodies', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ shares: 250 }))
    vi.stubGlobal('fetch', fetchMock)
    await engineApi.calculatePositionSize({ mode: 'risk_to_stop', entry_price: 100 })
    const [requestUrl, requestInit] = fetchMock.mock.calls[0]
    expect(String(requestUrl)).toBe('http://127.0.0.1:8000/api/v1/sizing/calculate')
    expect(requestInit.method).toBe('POST')
    expect(JSON.parse(requestInit.body)).toEqual({ mode: 'risk_to_stop', entry_price: 100 })
  })

  it('omits empty query parameters', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ events: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await engineApi.getEconomicCalendar({ minimumImpact: 'high', country: '' })
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://127.0.0.1:8000/api/v1/macro/calendar?impact=high')
  })
})

describe('normalizeCalendarResponse', () => {
  it('orders by release time and preserves a legitimate zero', () => {
    // TEST FIXTURE ONLY: synthetic calendar rows in the service's response shape.
    const calendar = normalizeCalendarResponse({
      from_date: '2026-11-21',
      to_date: '2026-11-28',
      cached: true,
      events: [
        { id: 'b', time: '2026-11-22T13:30:00Z', event: 'Later', actual: 0, estimate: null },
        { id: 'a', time: '2026-11-21T09:00:00Z', event: 'Earlier', actual: null, estimate: 0.2 },
        { id: 'bad', time: 'not-a-time', event: 'Dropped' },
      ],
    })
    expect(calendar.events.map((event) => event.id)).toEqual(['a', 'b'])
    expect(calendar.events[1].actual).toBe(0)
    expect(calendar.servedFromCache).toBe(true)
  })
})

describe('normalizeIndicatorResponse', () => {
  it('sorts, deduplicates and drops non-finite points in every series', () => {
    const chartData = normalizeIndicatorResponse({
      candles: [
        { time: 2, open: 1, high: 2, low: 0.5, close: 1.5 },
        { time: 1, open: 1, high: 2, low: 0.5, close: 1.2 },
        { time: 2, open: 1, high: 2, low: 0.5, close: 1.7 },
      ],
      indicators: [{ id: 'rsi_14', pane: 'oscillator', series: [{ key: 'RSI_14', style: 'line', data: [{ time: 2, value: 55 }, { time: 1, value: null }] }] }],
      summary: null,
    })
    expect(chartData.candles.map((candle) => candle.close)).toEqual([1.2, 1.7])
    expect(chartData.indicators[0].series[0].data).toEqual([{ time: 2, value: 55 }])
  })
})
