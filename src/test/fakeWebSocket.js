/**
 * TEST DOUBLE ONLY: an in-memory WebSocket used by unit tests to drive the
 * TerminalSocketClient without a network. Never used by the application.
 */
export class FakeWebSocket {
  static instances = []

  static reset() {
    FakeWebSocket.instances = []
  }

  static latest() {
    return FakeWebSocket.instances.at(-1)
  }

  constructor(url) {
    this.url = url
    this.readyState = 0
    this.closeCalls = []
    this.onopen = null
    this.onmessage = null
    this.onerror = null
    this.onclose = null
    FakeWebSocket.instances.push(this)
  }

  simulateOpen() {
    this.readyState = 1
    this.onopen?.({})
  }

  simulateMessage(payload) {
    this.onmessage?.({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) })
  }

  simulateServerClose() {
    this.readyState = 3
    this.onerror?.({})
    this.onclose?.({ code: 1006 })
  }

  close(code, reason) {
    this.readyState = 3
    this.closeCalls.push({ code, reason })
  }
}
