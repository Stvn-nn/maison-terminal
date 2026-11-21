import { describe, expect, it } from 'vitest'

import { EngineError } from '../services/api.js'
import { EMPTY_FORM_VALUES, buildSizingRequest, mapEngineErrorToFields } from './sizingForm.js'

function build(mode, formOverrides, options = {}) {
  return buildSizingRequest({
    mode,
    riskBasis: options.riskBasis ?? 'percent',
    side: options.side ?? 'auto',
    allowFractional: false,
    formValues: { ...EMPTY_FORM_VALUES, ...formOverrides },
  })
}

describe('buildSizingRequest', () => {
  it('sends percentages as percentage points (2% -> 2)', () => {
    const { sizingRequest, isValid } = build('risk_to_stop', {
      accountEquity: '50,000',
      riskPct: '1',
      entryPrice: '100',
      stopPrice: '98',
    })
    expect(isValid).toBe(true)
    expect(sizingRequest).toEqual({
      mode: 'risk_to_stop',
      allow_fractional: false,
      account_equity: 50000,
      risk_pct: 1,
      entry_price: 100,
      stop_price: 98,
    })
  })

  it('uses risk_cash for a fixed-dollar risk basis', () => {
    const { sizingRequest } = build(
      'risk_to_stop',
      { riskCash: '250', entryPrice: '40', stopPrice: '42' },
      { riskBasis: 'cash', side: 'short' },
    )
    expect(sizingRequest).toMatchObject({ risk_cash: 250, side: 'short' })
    expect(sizingRequest).not.toHaveProperty('risk_pct')
  })

  it('maps each mode to its own fields only', () => {
    expect(build('fixed_cash', { cashAmount: '1000', entryPrice: '33', riskPct: '9' }).sizingRequest).toEqual({
      mode: 'fixed_cash',
      allow_fractional: false,
      cash_amount: 1000,
      entry_price: 33,
    })
    expect(build('equity_pct', { accountEquity: '50000', equityPct: '10', entryPrice: '25' }).sizingRequest).toMatchObject({
      account_equity: 50000,
      equity_pct: 10,
    })
  })

  it('applies only the contract constraints', () => {
    const { fieldErrors, isValid } = build('equity_pct', { accountEquity: '-5', equityPct: '150' })
    expect(isValid).toBe(false)
    expect(fieldErrors).toEqual({
      accountEquity: 'Enter a number greater than 0',
      equityPct: 'Must be 100 or less',
      entryPrice: 'Required',
    })
  })
})

describe('mapEngineErrorToFields', () => {
  it('attaches direction errors to the stop field', () => {
    const engineError = new EngineError({ code: 'stop_on_wrong_side', message: 'A long stop must be below the entry price', status: 422 })
    expect(mapEngineErrorToFields(engineError).fieldErrors).toEqual({ stopPrice: 'A long stop must be below the entry price' })
  })

  it('maps pydantic validation locations to fields', () => {
    const engineError = new EngineError({
      code: 'validation_error',
      message: 'invalid',
      status: 422,
      details: [{ loc: ['body', 'risk_pct'], msg: 'Input should be less than or equal to 100' }],
    })
    expect(mapEngineErrorToFields(engineError).fieldErrors).toEqual({ riskPct: 'Input should be less than or equal to 100' })
  })

  it('keeps unrelated errors at form level', () => {
    const engineError = new EngineError({ code: 'engine_unreachable', message: 'offline', isNetworkError: true })
    expect(mapEngineErrorToFields(engineError)).toEqual({ fieldErrors: {}, formError: engineError })
  })
})
