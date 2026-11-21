import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FakeWebSocket } from '../test/fakeWebSocket.js'
import {
  HEARTBEAT_TIMEOUT_MS,
  MAX_RECONNECT_DELAY_MS,
  TEARDOWN_GRACE_MS,
  TerminalSocketClient,
  parseServerFrame,
  reconnectDelayForAttempt,
} from './terminalSocket.js'

const SOCKET_URL = 'ws://127.0.0.1:8000/ws'
const BACKTRACK_FRAME = {
  event: 'BACKTRACK_REQUIRED',
  message: 'Historical Context Needed: Please scroll back on your trading chart',
}

function createClient() {
  return new TerminalSocketClient({
    url: SOCKET_URL,
    WebSocketImplementation: FakeWebSocket,
    randomSource: () => 0.5, // no jitter: delays are exactly the capped exponential
  })
}

describe('parseServerFrame', () => {
  it('accepts the documented envelope', () => {
    expect(parseServerFrame(JSON.stringify(BACKTRACK_FRAME))).toEqual({ ...BACKTRACK_FRAME, ts: null, data: null })
  })

  it.each([
    ['not json', '{nope'],
    ['missing event', JSON.stringify({ message: 'x' })],
    ['non-string message', JSON.stringify({ event: 'X', message: 42 })],
    ['array', JSON.stringify([1, 2])],
    ['null', 'null'],
    ['binary', new ArrayBuffer(4)],
  ])('rejects %s', (_label, rawFrame) => {
    expect(parseServerFrame(rawFrame)).toBeNull()
  })
})

describe('reconnectDelayForAttempt', () => {
  it('grows exponentially and caps at 8 s', () => {
    const delays = [0, 1, 2, 3, 4, 5, 9].map((attempt) => reconnectDelayForAttempt(attempt, 0.5))
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000])
  })

  it('applies at most +/-20% jitter', () => {
    expect(reconnectDelayForAttempt(10, 0)).toBe(MAX_RECONNECT_DELAY_MS * 0.8)
    expect(reconnectDelayForAttempt(10, 1)).toBe(MAX_RECONNECT_DELAY_MS * 1.2)
  })
})

describe('TerminalSocketClient', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.reset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens exactly one socket across a Strict Mode mount/unmount/mount', () => {
    const client = createClient()
    const releaseFirstMount = client.retain()
    releaseFirstMount() // Strict Mode's simulated unmount
    const releaseSecondMount = client.retain() // immediate remount inside the grace period
    vi.advanceTimersByTime(TEARDOWN_GRACE_MS * 2)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.latest().closeCalls).toHaveLength(0)
    releaseSecondMount()
  })

  it('closes the socket after the last consumer releases it', () => {
    const client = createClient()
    const release = client.retain()
    FakeWebSocket.latest().simulateOpen()
    release()
    vi.advanceTimersByTime(TEARDOWN_GRACE_MS)
    expect(FakeWebSocket.latest().closeCalls).toEqual([{ code: 1000, reason: 'client stopped' }])
    expect(client.getSnapshot().connectionState).toBe('disconnected')
  })

  it('reports connected, then reconnects with capped backoff after the service drops', () => {
    const client = createClient()
    client.retain()
    expect(client.getSnapshot().connectionState).toBe('connecting')
    FakeWebSocket.latest().simulateOpen()
    expect(client.getSnapshot().connectionState).toBe('connected')

    const observedDelays = []
    for (let attempt = 0; attempt < 6; attempt += 1) {
      FakeWebSocket.latest().simulateServerClose()
      expect(client.getSnapshot().connectionState).toBe('reconnecting')
      const socketCountBefore = FakeWebSocket.instances.length
      let waitedMs = 0
      while (FakeWebSocket.instances.length === socketCountBefore) {
        vi.advanceTimersByTime(100)
        waitedMs += 100
      }
      observedDelays.push(waitedMs)
    }
    expect(observedDelays).toEqual([500, 1000, 2000, 4000, 8000, 8000])

    FakeWebSocket.latest().simulateOpen()
    expect(client.getSnapshot().connectionState).toBe('connected')
    FakeWebSocket.latest().simulateServerClose()
    vi.advanceTimersByTime(500) // backoff resets after a successful connection
    expect(FakeWebSocket.instances).toHaveLength(8)
  })

  it('keeps retrying while the service has not started yet, then recovers', () => {
    const client = createClient()
    client.retain()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      FakeWebSocket.latest().simulateServerClose()
      vi.advanceTimersByTime(MAX_RECONNECT_DELAY_MS)
    }
    FakeWebSocket.latest().simulateOpen() // service finally started
    expect(client.getSnapshot().connectionState).toBe('connected')
    expect(client.getSnapshot().lastConnectedAt).not.toBeNull()
  })

  it('treats heartbeat silence as a dead connection', () => {
    const client = createClient()
    client.retain()
    const firstSocket = FakeWebSocket.latest()
    firstSocket.simulateOpen()
    vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS - 1)
    firstSocket.simulateMessage({ event: 'HEARTBEAT', message: 'alive' }) // re-arms the watchdog
    vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS - 1)
    expect(client.getSnapshot().connectionState).toBe('connected')
    vi.advanceTimersByTime(1)
    expect(firstSocket.closeCalls[0]).toEqual({ code: 4000, reason: 'heartbeat timeout' })
    expect(client.getSnapshot().connectionState).toBe('reconnecting')
  })

  it('dispatches valid frames and ignores malformed ones without breaking', () => {
    const client = createClient()
    client.retain()
    const receivedFrames = []
    const failingListener = vi.fn(() => {
      throw new Error('listener bug')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    client.onEvent('BACKTRACK_REQUIRED', failingListener)
    client.onEvent('BACKTRACK_REQUIRED', (frame) => receivedFrames.push(frame))
    const socket = FakeWebSocket.latest()
    socket.simulateOpen()
    socket.simulateMessage('{"broken json')
    socket.simulateMessage({ event: 'SOMETHING_NEW', message: 'ignored by this listener' })
    socket.simulateMessage(BACKTRACK_FRAME)
    expect(failingListener).toHaveBeenCalledTimes(1)
    expect(receivedFrames).toHaveLength(1)
    expect(receivedFrames[0].message).toBe(BACKTRACK_FRAME.message)
    expect(client.getSnapshot().connectionState).toBe('connected')
  })

  it('reconnectNow skips the remaining backoff', () => {
    const client = createClient()
    client.retain()
    FakeWebSocket.latest().simulateServerClose()
    expect(FakeWebSocket.instances).toHaveLength(1)
    client.reconnectNow()
    expect(FakeWebSocket.instances).toHaveLength(2)
  })
})
