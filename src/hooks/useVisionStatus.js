import { useCallback, useState } from 'react'

import { engineApi } from '../services/api.js'
import { useOnEngineConnected, useTerminalEvent } from './useTerminalSocket.js'

/**
 * Chart-watch state from GET /api/v1/vision/status, refreshed on connect and whenever the
 * service broadcasts VISION_STATUS. Shown so the user can tell whether backtrack alerts
 * can arrive at all (the watch must be configured and started on the service).
 */
export function useVisionStatus() {
  const [visionStatus, setVisionStatus] = useState({
    state: 'unknown',
    running: false,
    lastError: null,
    region: null,
  })

  const refreshVisionStatus = useCallback(async () => {
    try {
      const statusBody = await engineApi.getVisionStatus()
      setVisionStatus({
        state: statusBody.state ?? 'unknown',
        running: Boolean(statusBody.running),
        lastError: statusBody.last_error ?? null,
        region: statusBody.config?.region ?? null,
      })
    } catch {
      setVisionStatus((previousStatus) => ({ ...previousStatus, state: 'unknown' }))
    }
  }, [])

  useOnEngineConnected(refreshVisionStatus)
  useTerminalEvent('VISION_STATUS', refreshVisionStatus)
  useTerminalEvent('BACKTRACK_REQUIRED', refreshVisionStatus)
  useTerminalEvent('BACKTRACK_CLEARED', refreshVisionStatus)

  return { ...visionStatus, refresh: refreshVisionStatus }
}
