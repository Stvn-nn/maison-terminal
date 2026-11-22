import { useEffect, useState } from 'react'

import { engineApi, isAbortError } from '../services/api.js'

/** How often to pull freshly read candles while the chart watch runs. */
export const SCREEN_POLL_INTERVAL_MS = 2_000

/** Cheap fingerprint so identical frames do not trigger recomputation. */
export function screenCandleSignature(candles) {
  if (!candles || candles.length === 0) return 'empty'
  const closeTotal = candles.reduce((runningTotal, candle) => runningTotal + candle.close, 0)
  const lastCandle = candles.at(-1)
  return `${candles.length}|${closeTotal.toFixed(2)}|${lastCandle.high}|${lastCandle.low}`
}

const INITIAL_SCREEN_CHART = {
  status: 'waiting', // 'waiting' | 'ready' | 'unreadable' | 'error'
  candles: [],
  capturedAt: null,
  region: null,
  note: null,
  isInView: true,
  signature: 'empty',
  sourceWindowTitle: null,
  symbol: null,
  titleLastPrice: null,
  titleChange: null,
  titleDirection: null,
}

/**
 * Candles the engine reads off the watched screen region (GET /api/v1/vision/candles).
 * Values are on a relative scale (100 = bottom of the chart, 200 = top), not prices.
 */
export function useScreenChart({ enabled }) {
  const [screenChart, setScreenChart] = useState(INITIAL_SCREEN_CHART)

  useEffect(() => {
    if (!enabled) return undefined
    let isDisposed = false
    let inFlightController = null

    const pollScreenCandles = async () => {
      inFlightController?.abort()
      inFlightController = new AbortController()
      try {
        const responseBody = await engineApi.getScreenCandles({ signal: inFlightController.signal })
        if (isDisposed) return
        const signature = screenCandleSignature(responseBody.candles)
        setScreenChart((previousChart) => ({
          status: responseBody.available ? 'ready' : 'unreadable',
          candles: signature === previousChart.signature ? previousChart.candles : responseBody.candles,
          capturedAt: responseBody.captured_at ? new Date(responseBody.captured_at) : null,
          region: responseBody.region,
          note: responseBody.note,
          isInView: responseBody.in_view !== false,
          signature,
          sourceWindowTitle: responseBody.source_window_title ?? null,
          symbol: responseBody.symbol ?? null,
          titleLastPrice: responseBody.title_last_price ?? null,
          titleChange: responseBody.title_change ?? null,
          titleDirection: responseBody.title_direction ?? null,
        }))
      } catch (pollError) {
        if (isDisposed || isAbortError(pollError)) return
        setScreenChart((previousChart) => ({ ...previousChart, status: 'error', note: pollError.message }))
      }
    }

    pollScreenCandles()
    const pollTimer = setInterval(pollScreenCandles, SCREEN_POLL_INTERVAL_MS)
    return () => {
      isDisposed = true
      clearInterval(pollTimer)
      inFlightController?.abort()
    }
  }, [enabled])

  return screenChart
}
