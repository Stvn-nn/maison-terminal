import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

import { engineApi, isAbortError } from '../services/api.js'
import { getOwnWindowScreenBounds } from './useNativeWindow.js'
import { useTerminalSocket } from './useTerminalSocket.js'
import { useVisionStatus } from './useVisionStatus.js'

const AUTO_WATCH_STORAGE_KEY = 'maison.chartWatch.auto'
/** How often to look for a chart while none is being watched, and to re-check state. */
export const AUTO_SCAN_INTERVAL_MS = 8_000
/** If the watched region shows no chart for this long (window moved/closed), scan again. */
export const RESCAN_AFTER_NO_CHART_MS = 20_000

export const ChartWatchContext = createContext(null)

function readStoredAutoWatch() {
  try {
    return window.localStorage.getItem(AUTO_WATCH_STORAGE_KEY) !== 'false'
  } catch {
    return true
  }
}

/**
 * Automatic chart watch: while enabled, the app asks the engine to find a broker chart on
 * screen (ignoring the Maison Terminal window), starts watching it, and scans again when
 * the chart disappears from the watched region. No setup commands are needed.
 */
export function useChartWatchController() {
  const { isConnected } = useTerminalSocket()
  const visionStatus = useVisionStatus()
  const [isAutoWatchEnabled, setIsAutoWatchEnabled] = useState(readStoredAutoWatch)
  const [scanState, setScanState] = useState({ phase: 'idle', message: null, lastScanAt: null })
  const isScanInFlightRef = useRef(false)
  const noChartSinceRef = useRef(null)
  const latestVisionStatusRef = useRef(visionStatus)

  useEffect(() => {
    latestVisionStatusRef.current = visionStatus
  }, [visionStatus])

  useEffect(() => {
    try {
      window.localStorage.setItem(AUTO_WATCH_STORAGE_KEY, String(isAutoWatchEnabled))
    } catch {
      // Storage unavailable: the preference simply resets to "on" next launch.
    }
  }, [isAutoWatchEnabled])

  const scanNow = useCallback(async () => {
    if (isScanInFlightRef.current) return
    isScanInFlightRef.current = true
    setScanState((previousState) => ({ ...previousState, phase: 'scanning' }))
    try {
      const ownWindowBounds = await getOwnWindowScreenBounds().catch(() => null)
      const scanResult = await engineApi.scanForChart({
        excludeRegions: ownWindowBounds ? [ownWindowBounds] : [],
        startWatch: true,
      })
      noChartSinceRef.current = null
      setScanState({
        phase: scanResult.found ? 'watching' : 'not_found',
        message: scanResult.message,
        lastScanAt: new Date(),
      })
      latestVisionStatusRef.current.refresh()
    } catch (scanError) {
      if (!isAbortError(scanError)) {
        setScanState({ phase: 'error', message: scanError.message, lastScanAt: new Date() })
      }
    } finally {
      isScanInFlightRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!isAutoWatchEnabled || !isConnected) return undefined
    const checkAndScan = () => {
      const { running, state, refresh } = latestVisionStatusRef.current
      refresh()
      if (!running) {
        scanNow()
        return
      }
      if (state === 'no_chart') {
        noChartSinceRef.current ??= Date.now()
        if (Date.now() - noChartSinceRef.current >= RESCAN_AFTER_NO_CHART_MS) scanNow()
      } else {
        noChartSinceRef.current = null
      }
    }
    checkAndScan()
    const scanTimer = setInterval(checkAndScan, AUTO_SCAN_INTERVAL_MS)
    return () => clearInterval(scanTimer)
  }, [isAutoWatchEnabled, isConnected, scanNow])

  const startWatching = useCallback(() => {
    setIsAutoWatchEnabled(true)
    scanNow()
  }, [scanNow])

  const stopWatching = useCallback(async () => {
    setIsAutoWatchEnabled(false)
    setScanState({ phase: 'idle', message: null, lastScanAt: null })
    try {
      await engineApi.stopChartWatch()
    } finally {
      latestVisionStatusRef.current.refresh()
    }
  }, [])

  return {
    isAutoWatchEnabled,
    isWatching: visionStatus.running,
    visionState: visionStatus.state,
    watchedRegion: visionStatus.region,
    scanState,
    scanNow,
    startWatching,
    stopWatching,
  }
}

/** The shared chart-watch state (see ChartWatchProvider). */
export function useChartWatch() {
  const chartWatch = useContext(ChartWatchContext)
  if (chartWatch === null) throw new Error('useChartWatch must be used inside ChartWatchProvider')
  return chartWatch
}
