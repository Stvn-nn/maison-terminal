import { ChevronDown, Info } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import { cn } from '../lib/cn.js'
import { SCORING_EXPLANATION, SIGNAL_LABELS, SIGNAL_MEANINGS, describeBiasForRisk } from '../lib/signalExplanation.js'

const BIAS_TEXT_CLASS = { bullish: 'text-gain', bearish: 'text-loss', neutral: 'text-bone' }

/**
 * "Python signal" chip that opens a panel explaining each check behind the engine's summary,
 * how they are scored, where the data came from, and what the reading means for risk.
 */
export default function SignalPanel({ summary, dataOrigin }) {
  const [isOpen, setIsOpen] = useState(false)
  const panelId = useId()
  const containerRef = useRef(null)

  useEffect(() => {
    if (!isOpen) return undefined
    const closeOnOutsideClick = (pointerEvent) => {
      if (!containerRef.current?.contains(pointerEvent.target)) setIsOpen(false)
    }
    const closeOnEscape = (keyEvent) => {
      if (keyEvent.key === 'Escape') setIsOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [isOpen])

  if (!summary) return null
  const scoreLabel = `${summary.score > 0 ? '+' : ''}${summary.score}`

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={() => setIsOpen((previousOpen) => !previousOpen)}
        className="flex items-center gap-1.5 rounded-full border border-divider px-2.5 py-1 text-[11px] text-muted hover:border-accent/50 hover:text-bone"
      >
        <span className="hidden md:inline">Python signal</span>
        <span className={cn('font-medium capitalize', BIAS_TEXT_CLASS[summary.bias])}>
          {summary.bias} ({scoreLabel})
        </span>
        <ChevronDown size={12} aria-hidden="true" className={cn('transition-transform', isOpen && 'rotate-180')} />
      </button>

      {isOpen && (
        <div
          id={panelId}
          role="dialog"
          aria-label="What the Python signal means"
          className="absolute top-full right-0 z-30 mt-2 w-[min(24rem,calc(100vw-2rem))] rounded-lg border border-divider bg-surface p-4 shadow-[0_12px_40px_rgba(0,0,0,0.6)]"
        >
          <p className="font-serif text-[17px] leading-tight font-semibold text-bone">
            Reading: <span className={cn('capitalize', BIAS_TEXT_CLASS[summary.bias])}>{summary.bias}</span>{' '}
            <span className="text-muted">({scoreLabel} of 5)</span>
          </p>
          <ul className="mt-3 flex flex-col gap-2.5">
            {summary.signals.map((signal) => (
              <li key={signal.name} className="text-[12px] leading-snug">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-bone">{SIGNAL_LABELS[signal.name] ?? signal.name}</span>
                  <span className={cn('shrink-0 text-[11px] font-medium capitalize', BIAS_TEXT_CLASS[signal.bias])}>
                    {signal.bias}
                  </span>
                </div>
                <p className="text-muted">{signal.detail}</p>
                {SIGNAL_MEANINGS[signal.name] && (
                  <p className="mt-0.5 text-[11px] text-muted/80">{SIGNAL_MEANINGS[signal.name]}</p>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-col gap-2 border-t border-divider pt-3 text-[11px] leading-snug text-muted">
            <p>{SCORING_EXPLANATION}</p>
            <p>
              <span className="font-medium text-bone">What it means for risk: </span>
              {describeBiasForRisk(summary.bias)}
            </p>
            <p className="flex gap-1.5">
              <Info size={12} aria-hidden="true" className="mt-px shrink-0" />
              <span>
                Source:{' '}
                {{
                  screen:
                    'candles read from your screen (relative scale: the chart’s shape, not its prices). Pick the pair, or show its ticker in the chart window title, for live prices.',
                  market: 'live prices from Yahoo Finance (may be delayed).',
                  file: 'prices from your CSV file.',
                }[dataOrigin] ?? 'the chart data.'}{' '}
                Computed by the Maison engine with pandas-ta. A description of the chart, not financial advice.
              </span>
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
