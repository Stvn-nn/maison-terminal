import { createContext, useCallback, useContext, useEffect, useRef, useSyncExternalStore } from 'react'

import { ENGINE_SOCKET_URL } from '../config.js'
import { getTerminalSocketClient } from '../services/terminalSocket.js'

/**
 * Lets tests (or a future multi-engine setup) supply their own TerminalSocketClient.
 * When no provider is present, the application-wide shared client is used.
 */
export const TerminalSocketContext = createContext(null)

function useSocketClient() {
  return useContext(TerminalSocketContext) ?? getTerminalSocketClient(ENGINE_SOCKET_URL)
}

/**
 * Engine connection state from the single shared /ws connection.
 * @returns {{connectionState: 'idle'|'connecting'|'connected'|'reconnecting'|'disconnected',
 *            lastConnectedAt: Date|null, lastMessageAt: Date|null, nextRetryAt: Date|null,
 *            isConnected: boolean, reconnectNow: () => void}}
 */
export function useTerminalSocket() {
  const socketClient = useSocketClient()
  useEffect(() => socketClient.retain(), [socketClient])
  const snapshot = useSyncExternalStore(socketClient.subscribeState, socketClient.getSnapshot)
  const reconnectNow = useCallback(() => socketClient.reconnectNow(), [socketClient])
  return { ...snapshot, isConnected: snapshot.connectionState === 'connected', reconnectNow }
}

/**
 * Subscribe to one server event type (e.g. "BACKTRACK_REQUIRED"). The handler may change
 * between renders without resubscribing; the subscription is torn down on unmount.
 */
export function useTerminalEvent(eventType, handleFrame) {
  const socketClient = useSocketClient()
  const latestHandlerRef = useRef(handleFrame)

  useEffect(() => {
    latestHandlerRef.current = handleFrame
  }, [handleFrame])

  useEffect(() => {
    const releaseConnection = socketClient.retain()
    const unsubscribe = socketClient.onEvent(eventType, (frame) => latestHandlerRef.current(frame))
    return () => {
      unsubscribe()
      releaseConnection()
    }
  }, [socketClient, eventType])
}

/** Run `onReconnected` each time the connection (re)opens. */
export function useOnEngineConnected(onReconnected) {
  const { lastConnectedAt } = useTerminalSocket()
  const latestCallbackRef = useRef(onReconnected)

  useEffect(() => {
    latestCallbackRef.current = onReconnected
  }, [onReconnected])

  useEffect(() => {
    if (lastConnectedAt !== null) latestCallbackRef.current()
  }, [lastConnectedAt])
}
