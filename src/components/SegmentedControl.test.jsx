import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

import SegmentedControl from './SegmentedControl.jsx'

const IMPACT_OPTIONS = [
  { value: 'high', label: 'High', description: 'High-impact releases only' },
  { value: 'medium', label: 'Med+', description: 'Medium- and high-impact releases' },
  { value: 'low', label: 'All', description: 'All releases, including low impact' },
]

function ImpactPicker() {
  const [selectedImpact, setSelectedImpact] = useState('medium')
  return (
    <SegmentedControl
      label="Impact"
      labelPlacement="inline"
      options={IMPACT_OPTIONS}
      value={selectedImpact}
      onChange={setSelectedImpact}
    />
  )
}

describe('SegmentedControl', () => {
  it('names the group with its visible label and explains each option', () => {
    render(<ImpactPicker />)
    expect(screen.getByRole('radiogroup', { name: 'Impact' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Med+' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('title', 'All releases, including low impact')
  })

  it('moves the selected bubble with clicks and arrow keys', async () => {
    const user = userEvent.setup()
    render(<ImpactPicker />)
    await user.click(screen.getByRole('radio', { name: 'High' }))
    expect(screen.getByRole('radio', { name: 'High' })).toHaveAttribute('aria-checked', 'true')

    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Med+' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Med+' })).toHaveFocus()

    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true')
  })

  it('keeps a single tab stop on the selected option', () => {
    render(<ImpactPicker />)
    const tabStops = screen.getAllByRole('radio').filter((radio) => radio.tabIndex === 0)
    expect(tabStops.map((radio) => radio.textContent)).toEqual(['Med+'])
  })
})
