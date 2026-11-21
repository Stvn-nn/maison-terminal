import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { usePositionSizing } from './usePositionSizing.js'

function deferredResponse() {
  let resolveResponse
  const promise = new Promise((resolve) => {
    resolveResponse = resolve
  })
  return { promise, resolve: (body) => resolveResponse(new Response(JSON.stringify(body), { status: 200 })) }
}

afterEach(() => vi.unstubAllGlobals())

describe('usePositionSizing', () => {
  it('never lets an older response overwrite a newer request', async () => {
    const firstResponse = deferredResponse()
    const secondResponse = deferredResponse()
    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_url, init) => {
        // The superseded request is aborted; resolve it late anyway to prove it is ignored.
        init.signal.addEventListener('abort', () => firstResponse.resolve({ shares: 1 }))
        return firstResponse.promise
      })
      .mockImplementationOnce(() => secondResponse.promise)
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => usePositionSizing())
    act(() => {
      result.current.calculate({ mode: 'fixed_cash', entry_price: 10, cash_amount: 10 })
    })
    act(() => {
      result.current.calculate({ mode: 'fixed_cash', entry_price: 10, cash_amount: 5000 })
    })
    await act(async () => secondResponse.resolve({ shares: 500 }))

    await waitFor(() => expect(result.current.status).toBe('success'))
    expect(result.current.result).toEqual({ shares: 500 })
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
  })

  it('cancelPending drops an in-flight request on a mode switch', async () => {
    const pendingResponse = deferredResponse()
    vi.stubGlobal('fetch', vi.fn(() => pendingResponse.promise))
    const { result } = renderHook(() => usePositionSizing())
    act(() => {
      result.current.calculate({ mode: 'equity_pct', entry_price: 10 })
    })
    expect(result.current.status).toBe('pending')
    act(() => result.current.cancelPending())
    await act(async () => pendingResponse.resolve({ shares: 99 }))
    expect(result.current.status).toBe('idle')
    expect(result.current.result).toBeNull()
  })
})
