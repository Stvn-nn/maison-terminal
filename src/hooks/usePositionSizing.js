import { useCallback, useEffect, useRef, useState } from 'react'

import { engineApi, isAbortError } from '../services/api.js'

/** Stable key describing a request, so results can be tied to the inputs that made them. */
export function sizingRequestKey(sizingRequest) {
  return JSON.stringify(sizingRequest, Object.keys(sizingRequest).sort())
}

const IDLE_STATE = { status: 'idle', result: null, error: null, submittedRequestKey: null }

/**
 * Position sizing through POST /api/v1/sizing/calculate. Python is the sole sizing
 * authority; this hook only submits, cancels superseded requests and tracks which inputs
 * the current result belongs to.
 */
export function usePositionSizing() {
  const [sizingState, setSizingState] = useState(IDLE_STATE)
  const inFlightControllerRef = useRef(null)
  const latestRequestIdRef = useRef(0)

  const cancelPending = useCallback(() => {
    inFlightControllerRef.current?.abort()
    inFlightControllerRef.current = null
    latestRequestIdRef.current += 1
    setSizingState((previousState) =>
      previousState.status === 'pending' ? { ...previousState, status: 'idle' } : previousState,
    )
  }, [])

  const calculate = useCallback(async (sizingRequest) => {
    inFlightControllerRef.current?.abort()
    const requestController = new AbortController()
    inFlightControllerRef.current = requestController
    latestRequestIdRef.current += 1
    const requestId = latestRequestIdRef.current
    const requestKey = sizingRequestKey(sizingRequest)

    setSizingState((previousState) => ({ ...previousState, status: 'pending', error: null }))
    try {
      const sizingResult = await engineApi.calculatePositionSize(sizingRequest, {
        signal: requestController.signal,
      })
      if (requestId !== latestRequestIdRef.current) return
      setSizingState({
        status: 'success',
        result: sizingResult,
        error: null,
        submittedRequestKey: requestKey,
        completedAt: new Date(),
      })
    } catch (requestError) {
      if (isAbortError(requestError) || requestId !== latestRequestIdRef.current) return
      setSizingState({
        status: 'error',
        result: null,
        error: requestError,
        submittedRequestKey: requestKey,
      })
    }
  }, [])

  const reset = useCallback(() => {
    cancelPending()
    setSizingState(IDLE_STATE)
  }, [cancelPending])

  useEffect(() => () => inFlightControllerRef.current?.abort(), [])

  return { ...sizingState, calculate, cancelPending, reset }
}
