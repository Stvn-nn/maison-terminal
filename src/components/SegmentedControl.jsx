import { useId, useRef } from 'react'

import { cn } from '../lib/cn.js'

const ARROW_KEY_STEPS = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }

/**
 * Pill ("bubble") selector with a visible label that says what the choices mean.
 * The selected option is a filled accent bubble; arrow keys move the selection
 * (standard radio-group keyboard behaviour), and each option can carry a tooltip.
 *
 * @param {{label: string, options: Array<{value: string, label: string, description?: string}>,
 *          value: string, onChange: (nextValue: string) => void,
 *          labelPlacement?: 'stacked' | 'inline', fillWidth?: boolean, className?: string}} props
 */
export default function SegmentedControl({
  label,
  options,
  value,
  onChange,
  labelPlacement = 'stacked',
  fillWidth = false,
  className,
}) {
  const labelId = useId()
  const optionElementsRef = useRef([])
  const selectedIndex = options.findIndex((option) => option.value === value)

  const moveSelectionWithArrowKeys = (keyEvent) => {
    const step = ARROW_KEY_STEPS[keyEvent.key]
    if (!step) return
    keyEvent.preventDefault()
    const nextIndex = (Math.max(selectedIndex, 0) + step + options.length) % options.length
    onChange(options[nextIndex].value)
    optionElementsRef.current[nextIndex]?.focus()
  }

  return (
    <div
      className={cn(
        labelPlacement === 'inline' ? 'flex items-center gap-2' : 'flex flex-col gap-1.5',
        className,
      )}
    >
      <span
        id={labelId}
        className="text-[10px] font-medium tracking-[0.14em] whitespace-nowrap text-muted uppercase"
      >
        {label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        onKeyDown={moveSelectionWithArrowKeys}
        className={cn(
          'rounded-full border border-divider bg-obsidian p-0.5',
          fillWidth ? 'grid auto-cols-fr grid-flow-col' : 'inline-flex w-fit',
        )}
      >
        {options.map((option, optionIndex) => {
          const isSelected = option.value === value
          const isTabStop = isSelected || (selectedIndex === -1 && optionIndex === 0)
          return (
            <button
              key={option.value}
              ref={(optionElement) => {
                optionElementsRef.current[optionIndex] = optionElement
              }}
              type="button"
              role="radio"
              aria-checked={isSelected}
              tabIndex={isTabStop ? 0 : -1}
              title={option.description}
              onClick={() => onChange(option.value)}
              className={cn(
                'rounded-full px-3 py-1 text-[11px] whitespace-nowrap transition-colors duration-150',
                isSelected
                  ? 'bg-accent font-semibold text-obsidian shadow-[0_1px_6px_rgba(106,134,176,0.35)]'
                  : 'text-muted hover:bg-surface-raised hover:text-bone',
              )}
            >
              {option.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
