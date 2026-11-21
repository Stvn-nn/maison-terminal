import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TerminalSocketContext } from '../hooks/useTerminalSocket.js'
import { TerminalSocketClient } from '../services/terminalSocket.js'
import { FakeWebSocket } from '../test/fakeWebSocket.js'
import BacktrackPrompt from './BacktrackPrompt.jsx'

const EXACT_BACKTRACK_PAYLOAD = {
  event: 'BACKTRACK_REQUIRED',
  message: 'Historical Context Needed: Please scroll back on your trading chart',
}

function renderWithSocket() {
  const socketClient = new TerminalSocketClient({ url: 'ws://test/ws', WebSocketImplementation: FakeWebSocket })
  render(
    <TerminalSocketContext.Provider value={socketClient}>
      <button type="button">Chart control</button>
      <BacktrackPrompt />
    </TerminalSocketContext.Provider>,
  )
  const socket = FakeWebSocket.latest()
  act(() => socket.simulateOpen())
  const deliver = (payload) => act(() => socket.simulateMessage(payload))
  return { deliver }
}

describe('BacktrackPrompt', () => {
  beforeEach(() => FakeWebSocket.reset())
  afterEach(() => FakeWebSocket.reset())

  it('shows one banner for duplicate events, dismisses locally, and resurfaces later', async () => {
    const user = userEvent.setup()
    const { deliver } = renderWithSocket()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    deliver(EXACT_BACKTRACK_PAYLOAD)
    deliver(EXACT_BACKTRACK_PAYLOAD)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert')).toHaveTextContent(EXACT_BACKTRACK_PAYLOAD.message)

    await user.click(screen.getByRole('button', { name: 'Dismiss historical context notice' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    deliver(EXACT_BACKTRACK_PAYLOAD)
    expect(screen.getByRole('alert')).toHaveTextContent(EXACT_BACKTRACK_PAYLOAD.message)
  })

  it('hides on the service clearing event', () => {
    const { deliver } = renderWithSocket()
    deliver(EXACT_BACKTRACK_PAYLOAD)
    deliver({ event: 'BACKTRACK_CLEARED', message: 'Chart structure visible' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('stays usable after malformed or unrelated frames', () => {
    const { deliver } = renderWithSocket()
    deliver('{"event": "BACKTRACK_REQUIRED"') // truncated JSON
    deliver({ event: 'BACKTRACK_REQUIRED' }) // missing message
    deliver({ event: 'HEARTBEAT', message: 'alive' })
    deliver({ event: 'SOMETHING_ELSE', message: 'x', data: [1, 2] })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    deliver(EXACT_BACKTRACK_PAYLOAD)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('renders the message as plain text and does not steal focus', () => {
    const { deliver } = renderWithSocket()
    const chartControl = screen.getByRole('button', { name: 'Chart control' })
    chartControl.focus()
    deliver({ event: 'BACKTRACK_REQUIRED', message: '<img src=x onerror=alert(1)> scroll back' })
    expect(screen.getByRole('alert')).toHaveTextContent('<img src=x onerror=alert(1)> scroll back')
    expect(screen.getByRole('alert').querySelector('img')).toBeNull()
    expect(chartControl).toHaveFocus()
  })
})
