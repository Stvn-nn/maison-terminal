/**
 * The single owner of the service's WebSocket channel (ws://127.0.0.1:8000/ws).
 *
 * - One connection per client instance; React components share it through hooks.
 * - Reference-counted with a short teardown grace period, so React Strict Mode's
 *   mount -> unmount -> mount cycle never opens a duplicate socket.
 * - Capped exponential backoff with jitter on reconnect.
 * - Heartbeat watchdog: the service sends HEARTBEAT every 20 s; silence for 45 s means
 *   the connection is dead even if the OS has not noticed yet.
 * - Frames are parsed defensively; malformed or unknown frames never break the client.
 *
 * The service needs no subscription message: every client receives every event.
 */

export const CONNECTION_STATES = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  DISCONNECTED: 'disconnected',
})

export const INITIAL_RECONNECT_DELAY_MS = 500
export const MAX_RECONNECT_DELAY_MS = 8_000
export const HEARTBEAT_TIMEOUT_MS = 45_000
export const TEARDOWN_GRACE_MS = 250
const ANY_EVENT = '*'

/** Validate one server frame. Returns null for anything that is not a WsEvent envelope. */
export function parseServerFrame(rawFrame) {
  if (typeof rawFrame !== 'string') return null
  let parsedFrame
  try {
    parsedFrame = JSON.parse(rawFrame)
  } catch {
    return null
  }
  if (
    parsedFrame === null ||
    typeof parsedFrame !== 'object' ||
    typeof parsedFrame.event !== 'string' ||
    typeof parsedFrame.message !== 'string'
  ) {
    return null
  }
  return {
    event: parsedFrame.event,
    message: parsedFrame.message,
    ts: typeof parsedFrame.ts === 'string' ? parsedFrame.ts : null,
    data: parsedFrame.data !== null && typeof parsedFrame.data === 'object' ? parsedFrame.data : null,
  }
}

export function reconnectDelayForAttempt(attemptNumber, randomValue = Math.random()) {
  const exponentialDelay = INITIAL_RECONNECT_DELAY_MS * 2 ** attemptNumber
  const cappedDelay = Math.min(MAX_RECONNECT_DELAY_MS, exponentialDelay)
  const jitterFactor = 0.8 + randomValue * 0.4 // +/- 20 %
  return Math.round(cappedDelay * jitterFactor)
}

export class TerminalSocketClient {
  constructor({
    url,
    WebSocketImplementation = globalThis.WebSocket,
    timers = { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) },
    randomSource = Math.random,
    now = () => new Date(),
  }) {
    this.url = url
    this.WebSocketImplementation = WebSocketImplementation
    this.timers = timers
    this.randomSource = randomSource
    this.now = now

    this.socket = null
    this.retainCount = 0
    this.isStarted = false
    this.reconnectAttempt = 0
    this.reconnectTimer = null
    this.heartbeatTimer = null
    this.teardownTimer = null

    this.stateListeners = new Set()
    this.eventListeners = new Map()
    this.snapshot = Object.freeze({
      connectionState: CONNECTION_STATES.IDLE,
      lastConnectedAt: null,
      lastMessageAt: null,
      nextRetryAt: null,
    })

    // Stable method references for useSyncExternalStore.
    this.subscribeState = this.subscribeState.bind(this)
    this.getSnapshot = this.getSnapshot.bind(this)
  }

  // --- Public API -----------------------------------------------------------------------

  /** Keep the connection alive while at least one consumer holds it. Returns a release fn. */
  retain() {
    this.retainCount += 1
    if (this.teardownTimer !== null) {
      this.timers.clearTimeout(this.teardownTimer)
      this.teardownTimer = null
    }
    if (!this.isStarted) this.start()
    let released = false
    return () => {
      if (released) return
      released = true
      this.retainCount -= 1
      if (this.retainCount === 0) {
        this.teardownTimer = this.timers.setTimeout(() => {
          this.teardownTimer = null
          if (this.retainCount === 0) this.stop()
        }, TEARDOWN_GRACE_MS)
      }
    }
  }

  subscribeState(listener) {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  getSnapshot() {
    return this.snapshot
  }

  /** Listen for one event type ("BACKTRACK_REQUIRED") or "*" for every valid frame. */
  onEvent(eventType, handler) {
    if (!this.eventListeners.has(eventType)) this.eventListeners.set(eventType, new Set())
    this.eventListeners.get(eventType).add(handler)
    return () => this.eventListeners.get(eventType)?.delete(handler)
  }

  /** Skip the backoff wait and try to connect now (e.g. a "Retry now" button). */
  reconnectNow() {
    if (!this.isStarted) return
    this.clearReconnectTimer()
    if (this.socket === null) this.openSocket()
  }

  start() {
    this.isStarted = true
    this.reconnectAttempt = 0
    this.openSocket()
  }

  stop() {
    this.isStarted = false
    this.clearReconnectTimer()
    this.clearHeartbeatTimer()
    this.closeCurrentSocket(1000, 'client stopped')
    this.updateSnapshot({ connectionState: CONNECTION_STATES.DISCONNECTED, nextRetryAt: null })
  }

  // --- Internals ------------------------------------------------------------------------

  updateSnapshot(changes) {
    this.snapshot = Object.freeze({ ...this.snapshot, ...changes })
    for (const listener of this.stateListeners) listener()
  }

  openSocket() {
    const isFirstAttempt = this.snapshot.lastConnectedAt === null && this.reconnectAttempt === 0
    this.updateSnapshot({
      connectionState: isFirstAttempt ? CONNECTION_STATES.CONNECTING : CONNECTION_STATES.RECONNECTING,
      nextRetryAt: null,
    })
    let socket
    try {
      socket = new this.WebSocketImplementation(this.url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    socket.onopen = () => {
      if (this.socket !== socket) return
      this.reconnectAttempt = 0
      this.updateSnapshot({ connectionState: CONNECTION_STATES.CONNECTED, lastConnectedAt: this.now() })
      this.armHeartbeatWatchdog()
    }
    socket.onmessage = (messageEvent) => {
      if (this.socket !== socket) return
      this.armHeartbeatWatchdog()
      this.updateSnapshot({ lastMessageAt: this.now() })
      const frame = parseServerFrame(messageEvent.data)
      if (frame !== null) this.dispatch(frame)
    }
    socket.onerror = () => {
      // The browser always follows an error with a close event; reconnect happens there.
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      this.clearHeartbeatTimer()
      if (this.isStarted) this.scheduleReconnect()
    }
  }

  dispatch(frame) {
    const typedListeners = [...(this.eventListeners.get(frame.event) ?? [])]
    const wildcardListeners = [...(this.eventListeners.get(ANY_EVENT) ?? [])]
    for (const listener of [...typedListeners, ...wildcardListeners]) {
      try {
        listener(frame)
      } catch (listenerError) {
        console.error('Terminal socket listener failed', listenerError)
      }
    }
  }

  scheduleReconnect() {
    this.clearReconnectTimer()
    const delayMs = reconnectDelayForAttempt(this.reconnectAttempt, this.randomSource())
    this.reconnectAttempt += 1
    this.updateSnapshot({
      connectionState: CONNECTION_STATES.RECONNECTING,
      nextRetryAt: new Date(this.now().getTime() + delayMs),
    })
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null
      if (this.isStarted) this.openSocket()
    }, delayMs)
  }

  armHeartbeatWatchdog() {
    this.clearHeartbeatTimer()
    this.heartbeatTimer = this.timers.setTimeout(() => {
      this.heartbeatTimer = null
      // Treat silence as a dead link: drop the socket and go through normal reconnect.
      this.closeCurrentSocket(4000, 'heartbeat timeout')
      if (this.isStarted) this.scheduleReconnect()
    }, HEARTBEAT_TIMEOUT_MS)
  }

  closeCurrentSocket(closeCode, closeReason) {
    const socket = this.socket
    this.socket = null
    if (!socket) return
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
    try {
      socket.close(closeCode, closeReason)
    } catch {
      // Closing a socket that never opened can throw in some engines; it is gone either way.
    }
  }

  clearReconnectTimer() {
    if (this.reconnectTimer !== null) {
      this.timers.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  clearHeartbeatTimer() {
    if (this.heartbeatTimer !== null) {
      this.timers.clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }
}

let sharedClient = null

/** The application-wide connection owner for the service's /ws channel. */
export function getTerminalSocketClient(url) {
  if (sharedClient === null) sharedClient = new TerminalSocketClient({ url })
  return sharedClient
}
