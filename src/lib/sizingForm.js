/**
 * Mapping between the sizing drawer's form and POST /api/v1/sizing/calculate.
 * The service is the sizing authority; this module only shapes the request and maps the
 * service's errors back onto fields. Percentages are percentage points (2 means 2%).
 */

/** Modes and their summaries, exactly as the service defines them. */
export const SIZING_MODES = [
  { value: 'risk_to_stop', label: 'Risk to stop', summary: 'Size so hitting the stop loses a set amount.' },
  { value: 'equity_pct', label: '% of equity', summary: 'Deploy a percentage of account equity.' },
  { value: 'fixed_cash', label: 'Fixed cash', summary: 'Deploy a fixed dollar amount.' },
]

const API_FIELD_BY_FORM_FIELD = {
  entryPrice: 'entry_price',
  stopPrice: 'stop_price',
  accountEquity: 'account_equity',
  cashAmount: 'cash_amount',
  equityPct: 'equity_pct',
  riskPct: 'risk_pct',
  riskCash: 'risk_cash',
}
const FORM_FIELD_BY_API_FIELD = Object.fromEntries(
  Object.entries(API_FIELD_BY_FORM_FIELD).map(([formField, apiField]) => [apiField, formField]),
)

export const FIELD_DEFINITIONS = {
  accountEquity: { label: 'Account equity', unit: 'USD', adornment: '$' },
  cashAmount: { label: 'Cash to deploy', unit: 'USD', adornment: '$' },
  equityPct: { label: 'Equity to deploy', unit: '% of equity', adornment: '%', maximum: 100 },
  riskPct: { label: 'Risk per trade', unit: '% of equity', adornment: '%', maximum: 100 },
  riskCash: { label: 'Risk per trade', unit: 'USD', adornment: '$' },
  entryPrice: { label: 'Entry price', unit: 'per share', adornment: '$' },
  stopPrice: { label: 'Stop-loss price', unit: 'per share', adornment: '$' },
}

export const EMPTY_FORM_VALUES = Object.freeze({
  accountEquity: '',
  cashAmount: '',
  equityPct: '',
  riskPct: '',
  riskCash: '',
  entryPrice: '',
  stopPrice: '',
})

/** Which inputs each mode uses, and which are required (mirrors the service contract). */
export function fieldsForMode(mode, riskBasis) {
  if (mode === 'fixed_cash') {
    return { required: ['cashAmount', 'entryPrice'], optional: ['stopPrice'] }
  }
  if (mode === 'equity_pct') {
    return { required: ['accountEquity', 'equityPct', 'entryPrice'], optional: ['stopPrice'] }
  }
  return riskBasis === 'cash'
    ? { required: ['riskCash', 'entryPrice', 'stopPrice'], optional: ['accountEquity'] }
    : { required: ['accountEquity', 'riskPct', 'entryPrice', 'stopPrice'], optional: [] }
}

function parsePositiveNumber(rawValue) {
  const trimmedValue = rawValue.trim().replace(/,/g, '')
  if (trimmedValue === '') return { isEmpty: true }
  const parsedValue = Number(trimmedValue)
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) return { error: 'Enter a number greater than 0' }
  return { value: parsedValue }
}

/**
 * Build the request body and client-side errors. Only the contract's own constraints are
 * checked here (required fields, > 0, percentages <= 100); direction rules such as a stop
 * on the wrong side of entry are reported by the service.
 */
export function buildSizingRequest({ mode, riskBasis, side, allowFractional, formValues }) {
  const { required, optional } = fieldsForMode(mode, riskBasis)
  const fieldErrors = {}
  const sizingRequest = { mode, allow_fractional: allowFractional }
  if (side !== 'auto') sizingRequest.side = side

  for (const formField of [...required, ...optional]) {
    const parsedField = parsePositiveNumber(formValues[formField] ?? '')
    if (parsedField.isEmpty) {
      if (required.includes(formField)) fieldErrors[formField] = 'Required'
      continue
    }
    if (parsedField.error) {
      fieldErrors[formField] = parsedField.error
      continue
    }
    const maximum = FIELD_DEFINITIONS[formField].maximum
    if (maximum !== undefined && parsedField.value > maximum) {
      fieldErrors[formField] = `Must be ${maximum} or less`
      continue
    }
    sizingRequest[API_FIELD_BY_FORM_FIELD[formField]] = parsedField.value
  }
  return { sizingRequest, fieldErrors, isValid: Object.keys(fieldErrors).length === 0 }
}

/** Map a service error onto the form's fields where the contract identifies one. */
export function mapEngineErrorToFields(engineError) {
  if (!engineError) return { fieldErrors: {}, formError: null }
  const fieldErrors = {}
  if (engineError.code === 'validation_error' && Array.isArray(engineError.details)) {
    for (const problem of engineError.details) {
      const formField = FORM_FIELD_BY_API_FIELD[problem?.loc?.[1]]
      if (formField && !fieldErrors[formField]) {
        fieldErrors[formField] = String(problem.msg ?? 'Invalid value').replace(/^Value error, /, '')
      }
    }
  } else if (engineError.code === 'missing_field') {
    const missingApiField = /'([a-z_]+)'/.exec(engineError.message)?.[1]
    const formField = FORM_FIELD_BY_API_FIELD[missingApiField]
    if (formField) fieldErrors[formField] = 'Required for this mode'
  } else if (engineError.code === 'zero_stop_distance' || engineError.code === 'stop_on_wrong_side') {
    fieldErrors.stopPrice = engineError.message
  }
  return { fieldErrors, formError: Object.keys(fieldErrors).length > 0 ? null : engineError }
}
