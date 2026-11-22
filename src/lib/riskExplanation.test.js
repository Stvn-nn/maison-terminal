import { describe, expect, it } from 'vitest'

import { explainSizingResult } from './riskExplanation.js'

// TEST FIXTURE ONLY: the shape of POST /api/v1/sizing/calculate responses.
const RISK_TO_STOP_RESULT = {
  mode: 'risk_to_stop',
  side: 'long',
  shares: 250,
  entry_price: 100,
  stop_price: 98,
  notional: 25000,
  stop_distance: 2,
  stop_distance_pct: 2,
  risk_amount: 500,
  risk_pct_of_equity: 1,
  notional_pct_of_equity: 50,
  capped_by_max_notional: false,
  targets: [
    { r_multiple: 1, price: 102 },
    { r_multiple: 3, price: 106 },
  ],
  warnings: [],
}

const textOf = (explanations) => explanations.map((explanation) => explanation.text).join(' ')

describe('explainSizingResult', () => {
  it('explains the loss at the stop, position value, R targets and rounding', () => {
    const explanations = explainSizingResult(RISK_TO_STOP_RESULT)
    const fullText = textOf(explanations)
    expect(fullText).toMatch(/stop at 98\.00, this position loses about \$500\.00, which is 1\.00% of your account/)
    expect(fullText).toMatch(/250 shares worth \$25,000\.00 \(50\.00% of your account\)/)
    expect(fullText).toMatch(/1R target at 102\.00 would gain about \$500\.00/)
    expect(fullText).toMatch(/3R target at 106\.00 about \$1,500\.00/)
    expect(fullText).toMatch(/rounded down/)
    expect(explanations.every((explanation) => explanation.tone === 'neutral')).toBe(true)
  })

  it('flags risk above the common guideline and leverage as cautions', () => {
    const explanations = explainSizingResult({
      ...RISK_TO_STOP_RESULT,
      risk_pct_of_equity: 5,
      notional_pct_of_equity: 250,
    })
    const cautionKeys = explanations
      .filter((explanation) => explanation.tone === 'caution')
      .map((explanation) => explanation.key)
    expect(cautionKeys).toEqual(['leverage', 'guideline'])
  })

  it('warns when no stop caps the loss', () => {
    const explanations = explainSizingResult({
      ...RISK_TO_STOP_RESULT,
      mode: 'fixed_cash',
      stop_price: null,
      risk_amount: null,
      risk_pct_of_equity: null,
      notional_pct_of_equity: null,
      targets: [],
    })
    expect(explanations[0]).toMatchObject({ key: 'no-stop', tone: 'caution' })
    expect(textOf(explanations)).not.toMatch(/R target/)
  })

  it('explains a zero-share result on its own', () => {
    expect(explainSizingResult({ ...RISK_TO_STOP_RESULT, shares: 0 })).toEqual([
      expect.objectContaining({ key: 'zero-shares', tone: 'caution' }),
    ])
  })
})
