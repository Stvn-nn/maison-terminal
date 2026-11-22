import { ChevronRight, Info, LoaderCircle, Scale } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'

import { useMediaQuery } from '../hooks/useMediaQuery.js'
import { sizingRequestKey, usePositionSizing } from '../hooks/usePositionSizing.js'
import { cn } from '../lib/cn.js'
import { formatClockTime, formatCurrency, formatPercentPoints, formatPrice, formatQuantity } from '../lib/format.js'
import InsightsPanel from './InsightsPanel.jsx'
import {
  EMPTY_FORM_VALUES,
  FIELD_DEFINITIONS,
  SIZING_MODES,
  buildSizingRequest,
  fieldsForMode,
  mapEngineErrorToFields,
} from '../lib/sizingForm.js'
import EngineStartHint from './EngineStartHint.jsx'
import SegmentedControl from './SegmentedControl.jsx'

const DRAWER_OPEN_STORAGE_KEY = 'maison.sizingDrawer.open'
/** Below this width the open drawer floats over the chart instead of taking space. */
const NARROW_WINDOW_QUERY = '(max-width: 899px)'
const DRAWER_TABS = [
  { value: 'size', label: 'Size' },
  { value: 'insights', label: 'Insights' },
]

function readStoredDrawerOpen() {
  try {
    return window.localStorage.getItem(DRAWER_OPEN_STORAGE_KEY) !== 'false'
  } catch {
    return true
  }
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
          'flex items-center rounded border bg-obsidian px-2.5 focus-within:border-accent/70',
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
  const [activeTab, setActiveTab] = useState('size')
  const [mode, setMode] = useState('risk_to_stop')
  const [riskBasis, setRiskBasis] = useState('percent')
  const [side, setSide] = useState('auto')
  const [allowFractional, setAllowFractional] = useState(false)
  const [formValues, setFormValues] = useState(EMPTY_FORM_VALUES)
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false)
  const sizing = usePositionSizing()
  const panelId = useId()
  const isNarrowWindow = useMediaQuery(NARROW_WINDOW_QUERY)
  const [wasNarrowWindow, setWasNarrowWindow] = useState(isNarrowWindow)

  // Collapse once when the window becomes narrow; the user can still reopen it.
  if (isNarrowWindow !== wasNarrowWindow) {
    setWasNarrowWindow(isNarrowWindow)
    if (isNarrowWindow) setIsOpen(false)
  }

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
        'flex shrink-0 border-l border-divider bg-surface transition-[width] duration-200 ease-out',
        !isOpen && 'relative w-11',
        isOpen && !isNarrowWindow && 'relative w-[min(340px,40vw)] min-w-[300px]',
        // Narrow windows: float over the chart instead of squeezing it.
        isOpen &&
          isNarrowWindow &&
          'absolute inset-y-0 right-0 z-30 w-[min(340px,calc(100vw-1rem))] shadow-[-12px_0_40px_rgba(0,0,0,0.55)]',
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
        <div
          role="tablist"
          aria-label="Drawer view"
          className="sticky top-0 z-10 flex gap-1 border-b border-divider bg-surface px-4 pt-3 pb-2"
        >
          {DRAWER_TABS.map((drawerTab) => (
            <button
              key={drawerTab.value}
              type="button"
              role="tab"
              aria-selected={activeTab === drawerTab.value}
              onClick={() => setActiveTab(drawerTab.value)}
              className={cn(
                'rounded-full px-3.5 py-1 text-[12px] transition-colors',
                activeTab === drawerTab.value
                  ? 'bg-accent font-semibold text-obsidian'
                  : 'text-muted hover:bg-surface-raised hover:text-bone',
              )}
            >
              {drawerTab.label}
            </button>
          ))}
        </div>

        {activeTab === 'insights' ? (
          <div role="tabpanel" aria-label="Insights" className="p-4">
            <InsightsPanel sizingResult={sizing.result} />
          </div>
        ) : (
        <form onSubmit={submitSizing} noValidate role="tabpanel" aria-label="Size" className="flex flex-col gap-4 p-4">
          <header>
            <h2 className="font-serif text-[20px] leading-none font-semibold text-bone">Position size</h2>
            <p className="mt-1.5 text-[11px] text-muted">{SIZING_MODES.find((option) => option.value === mode).summary}</p>
          </header>

          <SegmentedControl
            label="Sizing mode"
            options={SIZING_MODES.map((sizingMode) => ({ ...sizingMode, description: sizingMode.summary }))}
            value={mode}
            onChange={changeMode}
            fillWidth
          />

          {mode === 'risk_to_stop' && (
            <SegmentedControl
              label="Risk basis"
              options={[
                { value: 'percent', label: '% of equity', description: 'Risk a percentage of account equity' },
                { value: 'cash', label: 'Fixed $ risk', description: 'Risk a fixed dollar amount' },
              ]}
              value={riskBasis}
              onChange={setRiskBasis}
              fillWidth
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

          <div className="flex items-end justify-between gap-3">
            <SegmentedControl
              label="Direction"
              options={[
                { value: 'auto', label: 'Auto', description: 'Infer long or short from where the stop sits' },
                { value: 'long', label: 'Long', description: 'Long trade: stop below entry' },
                { value: 'short', label: 'Short', description: 'Short trade: stop above entry' },
              ]}
              value={side}
              onChange={setSide}
            />
            <label className="flex items-center gap-2 pb-1.5 text-[11px] whitespace-nowrap text-muted">
              <input
                type="checkbox"
                checked={allowFractional}
                onChange={(changeEvent) => setAllowFractional(changeEvent.target.checked)}
                className="size-3.5 accent-accent"
              />
              Fractional shares
            </label>
          </div>
          <p className="-mt-2 text-[10px] text-muted">Auto infers long/short from where the stop sits.</p>

          <button
            type="submit"
            className="inline-flex h-9 items-center justify-center gap-2 rounded-full bg-accent text-[12px] font-semibold tracking-wide text-obsidian shadow-[0_2px_10px_rgba(106,134,176,0.35)] transition-colors hover:bg-accent-strong"
          >
            {sizing.status === 'pending' && <LoaderCircle size={13} aria-hidden="true" className="motion-safe:animate-spin" />}
            {sizing.status === 'pending' ? 'Calculating…' : 'Calculate'}
          </button>

          <div aria-live="polite" className="flex flex-col gap-3">
            {serviceErrors.formError && (
              <div role="alert" className="rounded border border-loss/40 bg-loss/10 px-3 py-2 text-[12px] text-bone">
                {serviceErrors.formError.message}
                {serviceErrors.formError.code === 'engine_unreachable' && (
                  <EngineStartHint className="mt-1.5 block" />
                )}
              </div>
            )}

            {showResult && (
              <section aria-label="Sizing result" className={cn('flex flex-col gap-3', resultIsOutdated && 'opacity-45')}>
                {resultIsOutdated && (
                  <p className="text-[11px] font-medium text-caution">Inputs changed. These figures are for the previous inputs.</p>
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
                      <li key={warning} className="text-[11px] text-caution">
                        {warning}
                      </li>
                    ))}
                  </ul>
                )}

                <button
                  type="button"
                  onClick={() => setActiveTab('insights')}
                  className="flex items-center gap-1.5 self-start text-[11px] text-muted hover:text-bone"
                >
                  <Info size={12} aria-hidden="true" />
                  Calculated by the Maison engine
                  {sizing.completedAt ? ` · ${formatClockTime(sizing.completedAt)}` : ''} · What it means →
                </button>
              </section>
            )}
          </div>
        </form>
        )}
      </div>
    </aside>
  )
}
