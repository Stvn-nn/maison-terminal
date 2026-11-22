import { useCallback, useEffect, useRef, useState } from 'react'

import { MAX_CANDLES_PER_REQUEST } from '../config.js'
import { CandleFileError, parseCandleCsv } from '../lib/candles.js'
import { engineApi, isAbortError } from '../services/api.js'
import { useOnEngineConnected } from './useTerminalSocket.js'

const EMPTY_STATE = {
  status: 'empty', // 'empty' | 'parsing' | 'computing' | 'ready' | 'failed'
  sourceName: null,
  chartData: null,
  error: null,
  fileNotice: null,
  computedAt: null,
  datasetVersion: 0,
  hasRetryInput: false,
  // 'screen' (read off the user's screen, relative scale) | 'market' (live prices) | 'file' (CSV)
  dataOrigin: null,
  loadedForSource: null, // which chart source ('screen' | 'pair' | 'file') the data was loaded for
}

/**
 * Chart data for the workspace.
 *
 * The service has no price-history endpoint, so history comes from a broker CSV export the
 * user opens. The candles are sent once per file to POST /api/v1/indicators/compute and the
 * chart displays exactly what Python returns (candles + pandas-ta series).
 *
 * `datasetVersion` increments only when a new file is loaded, so the chart fits content
 * for new data but never resets the user's viewport on retries or reconnects.
 */
export function useIndicatorWorkspace() {
  const [workspaceState, setWorkspaceState] = useState(EMPTY_STATE)
  const pendingCandlesRef = useRef(null)
  const latestRequestIdRef = useRef(0)
  const inFlightControllerRef = useRef(null)

  const computeSeries = useCallback(async (candles, { sourceName, isNewDataset, dataOrigin, chartSource }) => {
    latestRequestIdRef.current += 1
    const requestId = latestRequestIdRef.current
    inFlightControllerRef.current?.abort()
    const requestController = new AbortController()
    inFlightControllerRef.current = requestController
    pendingCandlesRef.current = { candles, sourceName, dataOrigin, chartSource }

    setWorkspaceState((previousState) => ({
      ...previousState,
      status: 'computing',
      error: null,
      sourceName,
      hasRetryInput: true,
    }))
    try {
      const chartData = await engineApi.computeIndicators({
        candles,
        strategy: 'maison_core',
        signal: requestController.signal,
      })
      if (requestId !== latestRequestIdRef.current) return
      setWorkspaceState((previousState) => ({
        ...previousState,
        status: chartData.candles.length > 0 ? 'ready' : 'failed',
        chartData,
        dataOrigin,
        loadedForSource: chartSource ?? dataOrigin,
        error: chartData.candles.length > 0 ? null : new CandleFileError('The service returned no candles.'),
        computedAt: new Date(),
        datasetVersion: isNewDataset ? previousState.datasetVersion + 1 : previousState.datasetVersion,
      }))
    } catch (requestError) {
      if (isAbortError(requestError) || requestId !== latestRequestIdRef.current) return
      setWorkspaceState((previousState) => ({ ...previousState, status: 'failed', error: requestError }))
    }
  }, [])

  const loadCandleFile = useCallback(
    async (candleFile) => {
      if (!candleFile) return
      setWorkspaceState((previousState) => ({
        ...previousState,
        status: 'parsing',
        error: null,
        sourceName: candleFile.name,
      }))
      let parsedFile
      try {
        parsedFile = parseCandleCsv(await candleFile.text(), { maxCandles: MAX_CANDLES_PER_REQUEST })
      } catch (parseError) {
        setWorkspaceState((previousState) => ({ ...previousState, status: 'failed', error: parseError }))
        return
      }
      setWorkspaceState((previousState) => ({
        ...previousState,
        fileNotice: {
          skippedRowCount: parsedFile.skippedRowCount,
          truncatedRowCount: parsedFile.truncatedRowCount,
          candleCount: parsedFile.candles.length,
        },
      }))
      await computeSeries(parsedFile.candles, {
        sourceName: candleFile.name,
        isNewDataset: true,
        dataOrigin: 'file',
        chartSource: 'file',
      })
    },
    [computeSeries],
  )

  /**
   * Candles that keep updating: read off the screen (dataOrigin 'screen', relative scale) or
   * real market prices (dataOrigin 'market'). `chartSource` is the source tab they belong to.
   */
  const loadLiveCandles = useCallback(
    (candles, { isNewDataset, dataOrigin, chartSource, sourceName }) =>
      computeSeries(candles, { sourceName, isNewDataset, dataOrigin, chartSource }),
    [computeSeries],
  )

  /** Candles read from the screen by the chart watch (relative scale, placeholder times). */
  const loadScreenCandles = useCallback(
    (candles, { isNewDataset }) =>
      loadLiveCandles(candles, {
        sourceName: 'Your screen',
        isNewDataset,
        dataOrigin: 'screen',
        chartSource: 'screen',
      }),
    [loadLiveCandles],
  )

  const retry = useCallback(() => {
    const pending = pendingCandlesRef.current
    if (!pending) return
    const isFirstLoadOfFile = workspaceState.chartData === null
    computeSeries(pending.candles, {
      sourceName: pending.sourceName,
      isNewDataset: isFirstLoadOfFile,
      dataOrigin: pending.dataOrigin,
      chartSource: pending.chartSource,
    })
  }, [computeSeries, workspaceState.chartData])

  // Recover automatically when the engine comes back after a network failure.
  const retryAfterReconnect = useCallback(() => {
    if (workspaceState.status === 'failed' && workspaceState.error?.isRecoverable) retry()
  }, [retry, workspaceState.status, workspaceState.error])
  useOnEngineConnected(retryAfterReconnect)

  useEffect(() => () => inFlightControllerRef.current?.abort(), [])

  return {
    ...workspaceState,
    loadCandleFile,
    loadScreenCandles,
    loadLiveCandles,
    retry,
    canRetry: workspaceState.hasRetryInput,
  }
}
