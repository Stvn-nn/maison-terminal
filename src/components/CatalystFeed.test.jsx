import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FinnhubKeyContext } from '../hooks/useFinnhubKey.js'
import { TerminalSocketContext } from '../hooks/useTerminalSocket.js'
import { TerminalSocketClient } from '../services/terminalSocket.js'
import { FakeWebSocket } from '../test/fakeWebSocket.js'
import CatalystFeed from './CatalystFeed.jsx'

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// TEST FIXTURE ONLY: a key context with no key saved yet.
function keyContextStub(overrides = {}) {
  return { status: 'missing', calendarAvailable: null, keyVersion: 0, isDialogOpen: false, openKeyDialog: vi.fn(), dismissKeyDialog: vi.fn(), saveKey: vi.fn(), ...overrides }
}

function renderFeed(keyContext = keyContextStub()) {
  const socketClient = new TerminalSocketClient({ url: 'ws://test/ws', WebSocketImplementation: FakeWebSocket })
  return render(
    <TerminalSocketContext.Provider value={socketClient}>
      <FinnhubKeyContext.Provider value={keyContext}>
        <CatalystFeed />
      </FinnhubKeyContext.Provider>
    </TerminalSocketContext.Provider>,
  )
}

const inHours = (hoursFromNow) => new Date(Date.now() + hoursFromNow * 3_600_000).toISOString()

describe('CatalystFeed', () => {
  beforeEach(() => FakeWebSocket.reset())
  afterEach(() => vi.unstubAllGlobals())

  it('orders releases by time, labels the time zone, and shows only supplied values', async () => {
    // TEST FIXTURE ONLY: synthetic events in the service's calendar response shape.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          from_date: '2026-11-21',
          to_date: '2026-11-28',
          cached: false,
          events: [
            { id: 'late', time: inHours(30), country: 'US', event: 'Late release', impact: 'high', actual: null, estimate: 0, previous: 3.3, unit: '%' },
            { id: 'soon', time: inHours(2), country: 'EU', event: 'Soon release', impact: 'medium', actual: null, estimate: null, previous: null, unit: null },
            { id: 'past', time: inHours(-2), country: 'JP', event: 'Past release', impact: 'low', actual: 1, estimate: 1, previous: 1, unit: null },
          ],
        }),
      ),
    )
    renderFeed()
    const releaseList = await screen.findByRole('list', { name: /Upcoming macro releases/ })
    const releaseItems = within(releaseList).getAllByRole('listitem')
    expect(releaseItems.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Soon release'),
      expect.stringContaining('Late release'),
    ])
    expect(releaseItems[1]).toHaveTextContent('Est 0%') // legitimate zero is kept
    expect(releaseItems[0]).not.toHaveTextContent('Est') // not supplied -> not shown
    expect(screen.queryByText('Past release')).not.toBeInTheDocument()
    const timeZoneName = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(screen.getByText(new RegExp(timeZoneName.replace('/', '\\/')))).toBeInTheDocument()
  })

  it('distinguishes "no upcoming releases" from "feed unavailable"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ events: [] })))
    const { unmount } = renderFeed()
    expect(await screen.findByText(/No upcoming releases in the next 7 days/)).toBeInTheDocument()
    unmount()

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: { code: 'finnhub_premium_required', message: 'paid plan', details: null } }, 402),
      ),
    )
    renderFeed()
    expect(await screen.findByText('Feed unavailable')).toBeInTheDocument()
    expect(screen.getByText('Economic calendar requires a paid Finnhub plan')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Add key/ })).not.toBeInTheDocument()
  })

  it('offers Add key next to the warning when no key is set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: { code: 'finnhub_not_configured', message: 'no key', details: null } }, 503),
      ),
    )
    const keyContext = keyContextStub()
    renderFeed(keyContext)
    fireEvent.click(await screen.findByRole('button', { name: /Add key/ }))
    expect(keyContext.openKeyDialog).toHaveBeenCalled()
  })
})
