import { useCallback, useEffect, useRef, useState } from 'react'

import { CALENDAR_REFRESH_INTERVAL_MS } from '../config.js'
import { engineApi, isAbortError } from '../services/api.js'
import { useOnEngineConnected, useTerminalEvent } from './useTerminalSocket.js'

const INITIAL_STATE = {
  status: 'loading', // 'loading' | 'ready' | 'unavailable'
  events: [],
  error: null,
  lastUpdatedAt: null,
  isRefreshing: false,
}

/**
 * Upcoming macro releases from GET /api/v1/macro/calendar.
 *
 * - Polls at the service's cache lifetime (60 s) and refetches when the engine reconnects
 *   or announces MACRO_EVENT_UPCOMING.
 * - A failed refresh keeps the last good events visible and flags them as stale.
 * - Out-of-order responses are discarded so an older request never overwrites a newer one.
 */
export function useEconomicCalendar({ minimumImpact = 'high' } = {}) {
  const [calendarState, setCalendarState] = useState(INITIAL_STATE)
  const latestRequestIdRef = useRef(0)
  const inFlightControllerRef = useRef(null)

  const loadCalendar = useCallback(async () => {
    latestRequestIdRef.current += 1
    const requestId = latestRequestIdRef.current
    inFlightControllerRef.current?.abort()
    const requestController = new AbortController()
    inFlightControllerRef.current = requestController

    setCalendarState((previousState) => ({ ...previousState, isRefreshing: true }))
    try {
      const calendar = await engineApi.getEconomicCalendar({
        minimumImpact,
        signal: requestController.signal,
      })
      if (requestId !== latestRequestIdRef.current) return
      setCalendarState({
        status: 'ready',
        events: calendar.events,
        error: null,
        lastUpdatedAt: new Date(),
        isRefreshing: false,
      })
    } catch (requestError) {
      if (isAbortError(requestError) || requestId !== latestRequestIdRef.current) return
      setCalendarState((previousState) => ({
        ...previousState,
        status: previousState.lastUpdatedAt ? 'ready' : 'unavailable',
        error: requestError,
        isRefreshing: false,
      }))
    }
  }, [minimumImpact])

  useEffect(() => {
    loadCalendar()
    const refreshTimer = setInterval(loadCalendar, CALENDAR_REFRESH_INTERVAL_MS)
    return () => {
      clearInterval(refreshTimer)
      inFlightControllerRef.current?.abort()
    }
  }, [loadCalendar])

  useOnEngineConnected(loadCalendar)
  useTerminalEvent('MACRO_EVENT_UPCOMING', loadCalendar)

  return {
    ...calendarState,
    isStale: calendarState.error !== null && calendarState.lastUpdatedAt !== null,
    refresh: loadCalendar,
  }
}
