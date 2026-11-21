import { ChevronRight, LoaderCircle, Scale } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'

import { ENGINE_START_COMMAND } from '../config.js'
import { sizingRequestKey, usePositionSizing } from '../hooks/usePositionSizing.js'
import { cn } from '../lib/cn.js'
import { formatCurrency, formatPercentPoints, formatPrice, formatQuantity } from '../lib/format.js'
import {
  EMPTY_FORM_VALUES,
  FIELD_DEFINITIONS,
  SIZING_MODES,
  buildSizingRequest,
  fieldsForMode,
  mapEngineErrorToFields,
} from '../lib/sizingForm.js'

const DRAWER_OPEN_STORAGE_KEY = 'maison.sizingDrawer.open'

function readStoredDrawerOpen() {
  try {
    return window.localStorage.getItem(DRAWER_OPEN_STORAGE_KEY) !== 'false'
  } catch {
    return true
  }
}

function SegmentedControl({ label, options, value, onChange }) {
  return (
    <div role="radiogroup" aria-label={label} className="grid auto-cols-fr grid-flow-col rounded border border-divider p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-sm px-2 py-1 text-[11px] whitespace-nowrap transition-colors',
            value === option.value ? 'bg-surface-raised text-bone' : 'text-muted hover:text-bone',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function NumberField({ formField, value, onChange, error, isOptional }) {
  const inputId = useId()
  const errorId = `${inputId}-error`
  const definition = FIELD_DEFINITIONS[formField]
  const isPercent = definition.adornment === '%'
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="flex items-baseline justify-between text-[11px] text-muted">
        <span className="text-bone/90">
          {definition.label}
          {isOptional && <span className="text-muted"> (optional)</span>}
          <span className="sr-only">, </span>
        </span>
        <span>{definition.unit}</span>
      </label>
      <div
        className={cn(
          'flex items-center rounded border bg-obsidian px-2.5 focus-within:border-gold/70',
          error ? 'border-loss/70' : 'border-divider',
        )}
      >
        {!isPercent && <span aria-hidden="true" className="pr-1.5 text-[12px] text-muted">{definition.adornment}</span>}
        <input
          id={inputId}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(changeEvent) => onChange(formField, changeEvent.target.value)}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? errorId : undefined}
          className="h-8 w-full min-w-0 bg-transparent text-[13px] text-bone tabular-figures outline-none placeholder:text-muted/60 focus-visible:outline-none"
          placeholder="0.00"
        />
        {isPercent && <span aria-hidden="true" className="pl-1.5 text-[12px] text-muted">%</span>}
      </div>
      {error && (
        <p id={errorId} className="text-[11px] text-loss">
          {error}
        </p>
      )}
    </div>
  )
}

function ResultCard({ label, value, emphasis = false }) {
  return (
    <div className="flex flex-col gap-1 rounded border border-divider bg-obsidian px-3 py-2.5">
      <span className="text-[10px] tracking-[0.08em] whitespace-nowrap text-muted uppercase">{label}</span>
      <span className={cn('tabular-figures', emphasis ? 'text-[20px] font-medium text-bone' : 'text-[15px] text-bone')}>
        {value}
      </span>
    </div>
  )
}

/**
 * Right-hand position-sizing drawer. Inputs persist while the drawer is closed (the panel
 * stays mounted and is made inert). All sizing is computed by the Python service.
 */
export default function SizingDrawer() {
  const [isOpen, setIsOpen] = useState(readStoredDrawerOpen)
  const [mode, setMode] = useState('risk_to_stop')
  const [riskBasis, setRiskBasis] = useState('percent')
  const [side, setSide] = useState('auto')
  const [allowFractional, setAllowFractional] = useState(false)
  const [formValues, setFormValues] = useState(EMPTY_FORM_VALUES)
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false)
  const sizing = usePositionSizing()
  const panelId = useId()

  useEffect(() => {
    try {
      window.localStorage.setItem(DRAWER_OPEN_STORAGE_KEY, String(isOpen))
    } catch {
      // Storage unavailable (private mode); the drawer simply opens by default next time.
    }
  }, [isOpen])

  const builtRequest = useMemo(
    () => buildSizingRequest({ mode, riskBasis, side, allowFractional, formValues }),
    [mode, riskBasis, side, allowFractional, formValues],
  )
  const currentRequestKey = builtRequest.isValid ? sizingRequestKey(builtRequest.sizingRequest) : null
  const responseMatchesInputs = sizing.submittedRequestKey !== null && sizing.submittedRequestKey === currentRequestKey
  const serviceErrors = mapEngineErrorToFields(responseMatchesInputs ? sizing.error : null)
  const visibleFieldErrors = { ...(hasAttemptedSubmit ? builtRequest.fieldErrors : {}), ...serviceErrors.fieldErrors }
  const { required, optional } = fieldsForMode(mode, riskBasis)

  const updateField = (formField, nextValue) => {
    setFormValues((previousValues) => ({ ...previousValues, [formField]: nextValue }))
  }
  const changeMode = (nextMode) => {
    sizing.cancelPending() // a rapid mode switch must not let an older response land
    setMode(nextMode)
    setHasAttemptedSubmit(false)
  }
  const submitSizing = (submitEvent) => {
    submitEvent.preventDefault()
    setHasAttemptedSubmit(true)
    if (builtRequest.isValid) sizing.calculate(builtRequest.sizingRequest)
  }

  const sizingResult = sizing.result
  const showResult = sizingResult !== null
  const resultIsOutdated = showResult && !responseMatchesInputs

  return (
    <aside
      aria-label="Position sizing"
      className={cn(
        'relative flex shrink-0 border-l border-divider bg-surface transition-[width] duration-200 ease-out',
        isOpen ? 'w-[min(340px,40vw)] min-w-[300px]' : 'w-11',
      )}
    >
      <button
        type="button"
        onClick={() => setIsOpen((previousOpen) => !previousOpen)}
        aria-expanded={isOpen}
        aria-controls={panelId}
        aria-label={isOpen ? 'Collapse sizing drawer' : 'Expand sizing drawer'}
        className={cn(
          'flex shrink-0 flex-col items-center gap-3 border-r border-divider py-3 text-muted hover:text-bone',
          isOpen ? 'w-8' : 'w-11',
        )}
      >
        {isOpen ? (
          <ChevronRight size={14} aria-hidden="true" />
        ) : (
          <>
            <Scale size={15} aria-hidden="true" />
            <span className="text-[10px] tracking-[0.3em] uppercase [writing-mode:vertical-rl]">Sizing</span>
          </>
        )}
      </button>

      <div
        id={panelId}
        inert={!isOpen}
        className={cn('scrollbar-quiet min-w-0 flex-1 overflow-y-auto', !isOpen && 'invisible')}
      >
        <form onSubmit={submitSizing} noValidate className="flex flex-col gap-4 p-4">
          <header>
            <h2 className="font-serif text-[20px] leading-none font-semibold text-bone">Position size</h2>
            <p className="mt-1.5 text-[11px] text-muted">{SIZING_MODES.find((option) => option.value === mode).summary}</p>
          </header>

          <SegmentedControl label="Sizing mode" options={SIZING_MODES} value={mode} onChange={changeMode} />

          {mode === 'risk_to_stop' && (
            <SegmentedControl
              label="Risk basis"
              options={[
                { value: 'percent', label: '% of equity' },
                { value: 'cash', label: 'Fixed $ risk' },
              ]}
              value={riskBasis}
              onChange={setRiskBasis}
            />
          )}

          <div className="flex flex-col gap-3">
            {[...required, ...optional].map((formField) => (
              <NumberField
                key={formField}
                formField={formField}
                value={formValues[formField]}
                onChange={updateField}
                error={visibleFieldErrors[formField]}
                isOptional={optional.includes(formField)}
              />
            ))}
          </div>

          <div className="flex items-center justify-between gap-3">
            <SegmentedControl
              label="Trade direction"
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'long', label: 'Long' },
                { value: 'short', label: 'Short' },
              ]}
              value={side}
              onChange={setSide}
            />
            <label className="flex items-center gap-2 text-[11px] whitespace-nowrap text-muted">
              <input
                type="checkbox"
                checked={allowFractional}
                onChange={(changeEvent) => setAllowFractional(changeEvent.target.checked)}
                className="size-3.5 accent-gold"
              />
              Fractional shares
            </label>
          </div>
          <p className="-mt-2 text-[10px] text-muted">Auto infers long/short from where the stop sits.</p>

          <button
            type="submit"
            className="inline-flex h-9 items-center justify-center gap-2 rounded border border-gold/60 bg-gold/10 text-[12px] font-medium tracking-wide text-bone hover:bg-gold/20"
          >
            {sizing.status === 'pending' && <LoaderCircle size={13} aria-hidden="true" className="motion-safe:animate-spin" />}
            {sizing.status === 'pending' ? 'Calculating…' : 'Calculate'}
          </button>

          <div aria-live="polite" className="flex flex-col gap-3">
            {serviceErrors.formError && (
              <div role="alert" className="rounded border border-loss/40 bg-loss/10 px-3 py-2 text-[12px] text-bone">
                {serviceErrors.formError.message}
                {serviceErrors.formError.code === 'engine_unreachable' && (
                  <code className="mt-1.5 block text-[11px] text-bone/75" data-selectable>
                    {ENGINE_START_COMMAND}
                  </code>
                )}
              </div>
            )}

            {showResult && (
              <section aria-label="Sizing result" className={cn('flex flex-col gap-3', resultIsOutdated && 'opacity-45')}>
                {resultIsOutdated && (
                  <p className="text-[11px] font-medium text-gold">Inputs changed. These figures are for the previous inputs.</p>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <ResultCard label="Position size" value={`${formatQuantity(sizingResult.shares)} sh`} emphasis />
                  <ResultCard label="Max dollar risk" value={formatCurrency(sizingResult.risk_amount)} emphasis />
                  <ResultCard label="Notional value" value={formatCurrency(sizingResult.notional)} />
                  <ResultCard label="Risk of equity" value={formatPercentPoints(sizingResult.risk_pct_of_equity)} />
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px]" data-selectable>
                  {/* Rows appear only for values the service returned (null = not applicable). */}
                  {sizingResult.side !== null && (
                    <>
                      <dt className="text-muted">Direction</dt>
                      <dd className="text-right text-bone capitalize">{sizingResult.side}</dd>
                    </>
                  )}
                  {sizingResult.stop_distance !== null && (
                    <>
                      <dt className="text-muted">Stop distance</dt>
                      <dd className="text-right text-bone tabular-figures">
                        {formatPrice(sizingResult.stop_distance)} ({formatPercentPoints(sizingResult.stop_distance_pct)})
                      </dd>
                    </>
                  )}
                  {sizingResult.notional_pct_of_equity !== null && (
                    <>
                      <dt className="text-muted">Notional of equity</dt>
                      <dd className="text-right text-bone tabular-figures">
                        {formatPercentPoints(sizingResult.notional_pct_of_equity)}
                      </dd>
                    </>
                  )}
                  {sizingResult.targets.map((target) => (
                    <div key={target.r_multiple} className="contents">
                      <dt className="text-muted">{target.r_multiple}R target</dt>
                      <dd className="text-right text-bone tabular-figures">{formatPrice(target.price)}</dd>
                    </div>
                  ))}
                </dl>
                {sizingResult.warnings.length > 0 && (
                  <ul className="flex flex-col gap-1 border-t border-divider pt-2">
                    {sizingResult.warnings.map((warning) => (
                      <li key={warning} className="text-[11px] text-gold">
                        {warning}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </div>
        </form>
      </div>
    </aside>
  )
}
