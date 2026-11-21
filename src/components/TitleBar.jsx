import { Copy, Minus, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useNativeWindow } from '../hooks/useNativeWindow.js'
import { useTerminalSocket } from '../hooks/useTerminalSocket.js'
import { useVisionStatus } from '../hooks/useVisionStatus.js'
import { cn } from '../lib/cn.js'

const VISION_STATE_LABELS = {
  idle: 'Chart watch off',
  no_chart: 'Chart watch · no chart in view',
  structure_visible: 'Chart watch · structure visible',
  backtrack_required: 'Chart watch · history needed',
  unknown: 'Chart watch · unknown',
}

function useSecondsUntil(targetDate) {
  const [currentTime, setCurrentTime] = useState(() => Date.now())
  useEffect(() => {
    if (!targetDate) return undefined
    const tickTimer = setInterval(() => setCurrentTime(Date.now()), 500)
    return () => clearInterval(tickTimer)
  }, [targetDate])
  return targetDate ? Math.max(0, Math.ceil((targetDate.getTime() - currentTime) / 1000)) : null
}

function EngineStatus() {
  const { connectionState, nextRetryAt, reconnectNow } = useTerminalSocket()
  const secondsUntilRetry = useSecondsUntil(nextRetryAt)

  const statusPresentation = {
    connected: { label: 'Engine connected', dotClass: 'bg-gain' },
    connecting: { label: 'Connecting to engine…', dotClass: 'bg-gold animate-pulse-soft' },
    reconnecting: {
      label:
        secondsUntilRetry && secondsUntilRetry > 0
          ? `Engine offline · retry in ${secondsUntilRetry}s`
          : 'Engine offline · retrying…',
      dotClass: 'bg-loss',
    },
    disconnected: { label: 'Engine disconnected', dotClass: 'bg-loss' },
    idle: { label: 'Engine idle', dotClass: 'bg-muted' },
  }[connectionState]

  return (
    <div className="flex items-center gap-2" role="status" aria-live="polite">
      <span aria-hidden="true" className={cn('size-1.5 rounded-full', statusPresentation.dotClass)} />
      <span className="text-[11px] tracking-wide text-muted tabular-figures">{statusPresentation.label}</span>
      {connectionState === 'reconnecting' && (
        <button
          type="button"
          onClick={reconnectNow}
          className="rounded px-1.5 py-0.5 text-[11px] text-bone/80 hover:bg-surface-raised hover:text-bone"
        >
          Retry now
        </button>
      )}
    </div>
  )
}

function VisionStatusLabel() {
  const { state } = useVisionStatus()
  return (
    <span className={cn('text-[11px] tracking-wide', state === 'backtrack_required' ? 'text-gold' : 'text-muted')}>
      {VISION_STATE_LABELS[state] ?? VISION_STATE_LABELS.unknown}
    </span>
  )
}

function WindowControlButton({ label, onClick, isDestructive = false, children }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'grid h-9 w-11 place-items-center text-muted transition-colors focus-visible:-outline-offset-2',
        isDestructive ? 'hover:bg-loss hover:text-bone' : 'hover:bg-surface-raised hover:text-bone',
      )}
    >
      {children}
    </button>
  )
}

/**
 * Frameless window title bar. Only the wordmark area carries data-tauri-drag-region;
 * every interactive control sits outside it so clicks never start a window drag.
 * Double-clicking the drag region maximizes/restores natively.
 */
export default function TitleBar() {
  const { isNativeWindow, isMaximized, minimize, toggleMaximize, close } = useNativeWindow()

  return (
    <header className="flex h-9 shrink-0 items-stretch border-b border-divider bg-obsidian">
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-3 pl-4">
        <span className="pointer-events-none flex items-baseline gap-2 whitespace-nowrap">
          <span className="font-serif text-[19px] leading-none font-semibold tracking-wide text-bone">Maison</span>
          <span className="text-[10px] font-medium tracking-[0.32em] text-muted uppercase">Terminal</span>
        </span>
        {!isNativeWindow && (
          <span className="pointer-events-none rounded border border-divider px-1.5 py-px text-[10px] tracking-wide text-muted">
            Browser preview
          </span>
        )}
      </div>

      <div className="flex items-center gap-5 pr-3">
        <VisionStatusLabel />
        <EngineStatus />
      </div>

      {isNativeWindow && (
        <div className="flex items-stretch border-l border-divider">
          <WindowControlButton label="Minimize" onClick={minimize}>
            <Minus size={14} strokeWidth={1.5} aria-hidden="true" />
          </WindowControlButton>
          <WindowControlButton label={isMaximized ? 'Restore' : 'Maximize'} onClick={toggleMaximize}>
            {isMaximized ? (
              <Copy size={12} strokeWidth={1.5} aria-hidden="true" className="-scale-x-100" />
            ) : (
              <Square size={11} strokeWidth={1.5} aria-hidden="true" />
            )}
          </WindowControlButton>
          <WindowControlButton label="Close" onClick={close} isDestructive>
            <X size={15} strokeWidth={1.5} aria-hidden="true" />
          </WindowControlButton>
        </div>
      )}
    </header>
  )
}
