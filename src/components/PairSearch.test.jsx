import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import PairSearch from './PairSearch.jsx'

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// TEST FIXTURE ONLY: suggestions in the engine's /api/v1/market/search response shape.
const SEARCH_RESPONSE = {
  query: 'eur',
  source: 'Yahoo Finance (unofficial public data; may be delayed)',
  matches: [
    { symbol: 'EURUSD=X', name: 'EUR/USD', kind: 'forex', exchange: 'CCY' },
    { symbol: 'M6E=F', name: 'Micro EUR/USD Future', kind: 'future', exchange: 'CME' },
  ],
}

describe('PairSearch', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('suggests pairs while typing, with their asset type, and picks one with the keyboard', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(SEARCH_RESPONSE))
    vi.stubGlobal('fetch', fetchMock)
    const handleSelect = vi.fn()
    render(<PairSearch selectedPair={null} onSelect={handleSelect} onClear={() => {}} />)

    const searchInput = screen.getByRole('combobox', { name: 'Search pair or symbol' })
    fireEvent.focus(searchInput)
    fireEvent.change(searchInput, { target: { value: 'eur' } })

    const options = await screen.findAllByRole('option')
    expect(options).toHaveLength(2)
    expect(options[0]).toHaveTextContent('EURUSD=X')
    expect(options[0]).toHaveTextContent('Forex')
    expect(options[1]).toHaveTextContent('Futures')
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v1/market/search?q=eur')

    fireEvent.keyDown(searchInput, { key: 'ArrowDown' })
    fireEvent.keyDown(searchInput, { key: 'Enter' })
    expect(handleSelect).toHaveBeenCalledWith(SEARCH_RESPONSE.matches[1])
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
  })

  it('says when nothing matches', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ...SEARCH_RESPONSE, matches: [] })))
    render(<PairSearch selectedPair={null} onSelect={() => {}} onClear={() => {}} />)
    const searchInput = screen.getByRole('combobox')
    fireEvent.focus(searchInput)
    fireEvent.change(searchInput, { target: { value: 'zzzz' } })
    expect(await screen.findByText('No pairs match “zzzz”')).toBeInTheDocument()
  })

  it('shows the selected pair with a clear button', () => {
    const handleClear = vi.fn()
    render(
      <PairSearch
        selectedPair={{ symbol: 'AAPL', name: 'Apple Inc.', kind: 'stock' }}
        onSelect={() => {}}
        onClear={handleClear}
      />,
    )
    expect(screen.getByRole('combobox')).toHaveAttribute('placeholder', 'AAPL')
    expect(screen.getByText('Stock')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear AAPL' }))
    expect(handleClear).toHaveBeenCalled()
  })
})
