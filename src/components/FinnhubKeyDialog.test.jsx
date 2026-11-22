import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import FinnhubKeyDialog from './FinnhubKeyDialog.jsx'

function renderDialog(overrides = {}) {
  const handlers = { onDismiss: vi.fn(), onSave: vi.fn(), onDone: vi.fn(), ...overrides }
  render(<FinnhubKeyDialog {...handlers} />)
  return handlers
}

describe('FinnhubKeyDialog', () => {
  it('shows the MT mark and closes from the X or Escape', () => {
    const { onDismiss } = renderDialog()
    expect(screen.getByRole('dialog', { name: 'Add your Finnhub key' })).toBeInTheDocument()
    expect(screen.getByAltText('Maison Terminal')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalledTimes(2)
  })

  it('refuses text that cannot be a key without calling the engine', () => {
    const { onSave } = renderDialog()
    fireEvent.change(screen.getByPlaceholderText('Paste your key'), { target: { value: 'not a key!' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('doesn’t look like a Finnhub key')
  })

  it('explains a rejected key', async () => {
    const rejection = Object.assign(new Error('rejected'), { code: 'finnhub_key_invalid' })
    renderDialog({ onSave: vi.fn(async () => Promise.reject(rejection)) })
    fireEvent.change(screen.getByPlaceholderText('Paste your key'), { target: { value: 'abcdef123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Finnhub didn’t accept that key')
  })

  it('confirms a saved free key and says the calendar needs a paid plan', async () => {
    const { onSave, onDone } = renderDialog({
      onSave: vi.fn(async () => ({ configured: true, calendar_available: false })),
    })
    fireEvent.change(screen.getByPlaceholderText('Paste your key'), { target: { value: ' abcdef123456 ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }))
    expect(await screen.findByRole('dialog', { name: 'Key saved' })).toHaveTextContent('needs a paid Finnhub plan')
    expect(onSave).toHaveBeenCalledWith('abcdef123456')
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onDone).toHaveBeenCalled()
  })
})
