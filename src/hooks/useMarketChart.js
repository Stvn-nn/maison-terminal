import { useEffect, useState } from 'react'

import { refreshIntervalMs } from '../lib/marketSymbols.js'
import { engineApi, isAbortError } from '../services/api.js'

const IDLE_MARKET_CHART = {
  status: 'idle', // 'idle' | 'loading' | 'ready' | 'error'
  datasetKey: null,
  candles: [],
  meta: null,
  fetchedAt: null,
  error: null,
  signature: 'empty',
}

function candleSignature(candles) {
  const lastCandle = candles.at(-1)
  return lastCandle
    ? `${candles.length}|${lastCandle.time}|${lastCandle.open}|${lastCandle.high}|${lastCandle.low}|${lastCandle.close}`
    : 'empty'
}

/**
 * Real price bars for a symbol (GET /api/v1/market/candles), refreshed on a timer so the
 * chart tracks the market. `datasetKey` changes only when the symbol or timeframe does, so
 * the chart can refit for a new instrument but keep the user's viewport on refreshes.
 */
export function useMarketChart({ symbol, timeframe, enabled }) {
  const datasetKey = symbol ? `${symbol}|${timeframe}` : null
  const [marketChart, setMarketChart] = useState(IDLE_MARKET_CHART)

  useEffect(() => {
    if (!enabled || !symbol) return undefined
    let isDisposed = false
    let inFlightController = null

    const fetchCandles = async () => {
      inFlightController?.abort()
      inFlightController = new AbortController()
      setMarketChart((previousChart) =>
        previousChart.datasetKey === datasetKey
          ? previousChart
          : { ...IDLE_MARKET_CHART, status: 'loading', datasetKey },
      )
      try {
        const responseBody = await engineApi.getMarketCandles({
          symbol,
          timeframe,
          signal: inFlightController.signal,
        })
        if (isDisposed) return
        const signature = candleSignature(responseBody.candles)
        setMarketChart((previousChart) => ({
          status: 'ready',
          datasetKey,
          candles:
            previousChart.datasetKey === datasetKey && previousChart.signature === signature
              ? previousChart.candles
              : responseBody.candles,
          meta: {
            symbol: responseBody.symbol,
            name: responseBody.name,
            kind: responseBody.kind,
            currency: responseBody.currency,
            exchange: responseBody.exchange,
            lastPrice: responseBody.last_price,
            source: responseBody.source,
          },
          fetchedAt: new Date(),
          error: null,
          signature,
        }))
      } catch (fetchError) {
        if (isDisposed || isAbortError(fetchError)) return
        // Keep showing the last good bars for this dataset; just record the failure.
        setMarketChart((previousChart) => ({
          ...(previousChart.datasetKey === datasetKey ? previousChart : { ...IDLE_MARKET_CHART, datasetKey }),
          status: previousChart.datasetKey === datasetKey && previousChart.candles.length > 0 ? 'ready' : 'error',
          error: fetchError,
        }))
      }
    }

    fetchCandles()
    const refreshTimer = setInterval(fetchCandles, refreshIntervalMs(timeframe))
    return () => {
      isDisposed = true
      clearInterval(refreshTimer)
      inFlightController?.abort()
    }
  }, [enabled, symbol, timeframe, datasetKey])

  if (!enabled || !symbol) return IDLE_MARKET_CHART
  return marketChart.datasetKey === datasetKey ? marketChart : { ...IDLE_MARKET_CHART, status: 'loading', datasetKey }
}
