import { useEffect, useState } from 'react'

import { engineApi, isAbortError } from '../services/api.js'

const SENTIMENT_REFRESH_INTERVAL_MS = 5 * 60_000

/** News sentiment for the detected symbol, refreshed every few minutes. */
export function useSymbolSentiment(symbol) {
  const [sentimentState, setSentimentState] = useState({ status: 'idle', sentiment: null, error: null, symbol: null })

  useEffect(() => {
    if (!symbol) return undefined
    let isDisposed = false
    let inFlightController = null
    const loadSentiment = async () => {
      inFlightController?.abort()
      inFlightController = new AbortController()
      try {
        const sentiment = await engineApi.getSymbolSentiment(symbol, { signal: inFlightController.signal })
        if (!isDisposed) setSentimentState({ status: 'ready', sentiment, error: null, symbol })
      } catch (sentimentError) {
        if (isDisposed || isAbortError(sentimentError)) return
        setSentimentState({ status: 'unavailable', sentiment: null, error: sentimentError, symbol })
      }
    }
    loadSentiment()
    const refreshTimer = setInterval(loadSentiment, SENTIMENT_REFRESH_INTERVAL_MS)
    return () => {
      isDisposed = true
      clearInterval(refreshTimer)
      inFlightController?.abort()
    }
  }, [symbol])

  return sentimentState.symbol === symbol ? sentimentState : { status: symbol ? 'loading' : 'idle', sentiment: null, error: null }
}
