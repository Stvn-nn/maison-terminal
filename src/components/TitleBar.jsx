import { Copy, EyeOff, Minus, ScanEye, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { ENGINE_STARTUP_GRACE_MS } from '../config.js'
import { useChartWatch } from '../hooks/useChartWatch.js'
import { useNativeWindow } from '../hooks/useNativeWindow.js'
import { useTerminalSocket } from '../hooks/useTerminalSocket.js'
import { cn } from '../lib/cn.js'

function useSecondsUntil(targetDate) {
  const [currentTime, setCurrentTime] = useState(() => Date.now())
  useEffect(() => {
    if (!targetDate) return undefined
    const tickTimer = setInterval(() => setCurrentTime(Date.now()), 500)
    return () => clearInterval(tickTimer)
  }, [targetDate])
  return targetDate ? Math.max(0, Math.ceil((targetDate.getTime() - currentTime) / 1000)) : null
}

/** True for the first moments after launch, while the bundled engine is still booting. */
function useIsWithinStartupGrace() {
  const [isWithinStartupGrace, setIsWithinStartupGrace] = useState(true)
  useEffect(() => {
    const graceTimer = setTimeout(() => setIsWithinStartupGrace(false), ENGINE_STARTUP_GRACE_MS)
    return () => clearTimeout(graceTimer)
  }, [])
  return isWithinStartupGrace
}

function EngineStatus() {
  const { connectionState, lastConnectedAt, nextRetryAt, reconnectNow } = useTerminalSocket()
  const secondsUntilRetry = useSecondsUntil(nextRetryAt)
  const isWithinStartupGrace = useIsWithinStartupGrace()
  const isStillStarting = connectionState !== 'connected' && lastConnectedAt === null && isWithinStartupGrace

  const statusPresentation = isStillStarting
    ? { label: 'Starting engine…', dotClass: 'bg-accent animate-pulse-soft' }
    : {
    connected: { label: 'Engine connected', dotClass: 'bg-gain' },
    connecting: { label: 'Connecting to engine…', dotClass: 'bg-accent animate-pulse-soft' },
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
      <span className="hidden text-[11px] tracking-wide text-muted tabular-figures sm:inline">
        {statusPresentation.label}
      </span>
      <span className="sr-only sm:hidden">{statusPresentation.label}</span>
      {connectionState === 'reconnecting' && !isStillStarting && (
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

function describeChartWatch({ isConnected, isAutoWatchEnabled, isWatching, visionState, scanState }) {
  if (!isConnected) return { label: 'Chart watch · waiting for engine', tone: 'muted' }
  if (!isAutoWatchEnabled && !isWatching) return { label: 'Chart watch off', tone: 'muted' }
  if (scanState.phase === 'scanning') return { label: 'Looking for a chart…', tone: 'accent' }
  if (isWatching) {
    if (visionState === 'backtrack_required') return { label: 'Watching · history needed', tone: 'accent' }
    if (visionState === 'no_chart') return { label: 'Watching · chart not in view', tone: 'muted' }
    return { label: 'Watching your chart', tone: 'accent' }
  }
  if (scanState.phase === 'not_found') return { label: 'No chart on screen', tone: 'muted' }
  return { label: 'Chart watch starting…', tone: 'muted' }
}

function ChartWatchToggle() {
  const chartWatch = useChartWatch()
  const { isConnected } = useTerminalSocket()
  const { label, tone } = describeChartWatch({ ...chartWatch, isConnected })
  const isOn = chartWatch.isAutoWatchEnabled || chartWatch.isWatching
  const region = chartWatch.watchedRegion
  const tooltip = [
    isOn ? 'Click to stop watching your screen' : 'Click to find and watch your broker chart',
    region && chartWatch.isWatching
      ? `Watching ${region.width}×${region.height} px at (${region.left}, ${region.top})`
      : null,
    chartWatch.scanState.phase === 'not_found'
      ? 'Place your broker chart beside Maison Terminal so it is visible on screen.'
      : null,
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <button
      type="button"
      onClick={isOn ? chartWatch.stopWatching : chartWatch.startWatching}
      aria-pressed={isOn}
      title={tooltip}
      className="flex items-center gap-2 rounded-full px-2 py-1 text-[11px] tracking-wide hover:bg-surface-raised"
    >
      {isOn ? (
        <ScanEye size={13} aria-hidden="true" className={tone === 'accent' ? 'text-accent' : 'text-muted'} />
      ) : (
        <EyeOff size={13} aria-hidden="true" className="text-muted" />
      )}
      <span className={cn('hidden md:inline', tone === 'accent' ? 'text-bone' : 'text-muted')}>{label}</span>
      <span className="sr-only md:hidden">{label}</span>
    </button>
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
          <span className="pointer-events-none hidden rounded border border-divider px-1.5 py-px text-[10px] tracking-wide text-muted lg:inline">
            Browser preview
          </span>
        )}
      </div>

      <div className="flex items-center gap-3 pr-3 md:gap-5">
        <ChartWatchToggle />
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
