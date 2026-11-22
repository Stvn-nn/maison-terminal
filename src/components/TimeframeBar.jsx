import { cn } from '../lib/cn.js'
import { TIMEFRAMES } from '../lib/marketSymbols.js'

/** Compact timeframe strip over the chart's top-left corner (1m … M), like charting apps. */
export default function TimeframeBar({ value, onChange, className }) {
  return (
    <div
      role="radiogroup"
      aria-label="Timeframe"
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full border border-divider bg-obsidian/90 p-0.5 backdrop-blur-sm',
        className,
      )}
    >
      {TIMEFRAMES.map((timeframe) => {
        const isSelected = timeframe.value === value
        return (
          <button
            key={timeframe.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            title={timeframe.description}
            onClick={() => onChange(timeframe.value)}
            className={cn(
              'min-w-7 rounded-full px-2 py-0.5 text-[11px] tabular-figures transition-colors',
              isSelected
                ? 'bg-accent font-semibold text-obsidian'
                : 'text-muted hover:bg-surface-raised hover:text-bone',
            )}
          >
            {timeframe.label}
          </button>
        )
      })}
    </div>
  )
}
