import { History, X } from 'lucide-react'
import { useCallback, useReducer } from 'react'

import { useTerminalEvent } from '../hooks/useTerminalSocket.js'
import { INITIAL_BACKTRACK_STATE, backtrackReducer } from '../lib/backtrackAlert.js'

/**
 * Floating notice relaying the screen-vision service's request for more chart history.
 * It never moves the chart or steals focus: scrolling back stays the user's action.
 */
export default function BacktrackPrompt() {
  const [backtrackState, dispatchBacktrack] = useReducer(backtrackReducer, INITIAL_BACKTRACK_STATE)

  const handleBacktrackRequired = useCallback((frame) => {
    dispatchBacktrack({ type: 'required', message: frame.message, receivedAt: new Date() })
  }, [])
  const handleBacktrackCleared = useCallback(() => dispatchBacktrack({ type: 'cleared' }), [])

  useTerminalEvent('BACKTRACK_REQUIRED', handleBacktrackRequired)
  useTerminalEvent('BACKTRACK_CLEARED', handleBacktrackCleared)

  if (!backtrackState.isVisible) return null

  return (
    <div className="pointer-events-none absolute top-14 left-4 z-20 max-w-[min(26rem,calc(100%-2rem))]">
      <div
        role="alert"
        className="pointer-events-auto flex animate-banner-in items-start gap-3 rounded-md border border-gold/40 bg-obsidian/95 py-3 pr-2 pl-3.5 shadow-[0_8px_30px_rgba(0,0,0,0.55)] backdrop-blur-sm"
      >
        <History aria-hidden="true" size={16} strokeWidth={1.6} className="mt-0.5 shrink-0 text-gold" />
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-medium tracking-[0.22em] text-gold uppercase">Chart watch</p>
          {/* Rendered as plain text: React escapes the service-supplied message. */}
          <p className="mt-1 text-[13px] leading-snug text-bone" data-selectable>
            {backtrackState.message}
          </p>
        </div>
        <button
          type="button"
          onClick={() => dispatchBacktrack({ type: 'dismissed' })}
          aria-label="Dismiss historical context notice"
          className="grid size-7 shrink-0 place-items-center rounded text-muted hover:bg-surface-raised hover:text-bone"
        >
          <X size={14} strokeWidth={1.6} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
