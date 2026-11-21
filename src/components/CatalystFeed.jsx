import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useEconomicCalendar } from '../hooks/useEconomicCalendar.js'
import { cn } from '../lib/cn.js'
import EngineStartHint from './EngineStartHint.jsx'
import {
  formatClockTime,
  formatCountdown,
  formatReleaseTime,
  formatReleaseValue,
  localTimeZoneLabel,
} from '../lib/format.js'

const IMPACT_PRESENTATION = {
  high: { label: 'High', dotClass: 'bg-impact-high', textClass: 'text-impact-high' },
  medium: { label: 'Med', dotClass: 'bg-impact-medium', textClass: 'text-impact-medium' },
  low: { label: 'Low', dotClass: 'bg-impact-low', textClass: 'text-impact-low' },
}

const IMPACT_FILTERS = [
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Med+' },
  { value: 'low', label: 'All' },
]

const UNAVAILABLE_REASONS = {
  engine_unreachable: 'Analytical service offline',
  request_timeout: 'Analytical service not responding',
  finnhub_not_configured: 'No Finnhub API key configured on the analytical service',
  finnhub_premium_required: 'Economic calendar requires a paid Finnhub plan',
  finnhub_unauthorized: 'Finnhub rejected the service’s API key',
  finnhub_rate_limited: 'Finnhub rate limit reached; retrying shortly',
  finnhub_unavailable: 'Finnhub is not reachable from the analytical service',
}

function describeFeedError(feedError) {
  return UNAVAILABLE_REASONS[feedError?.code] ?? feedError?.message ?? 'Feed unavailable'
}

function useCurrentTime(intervalMs) {
  const [currentTime, setCurrentTime] = useState(() => Date.now())
  useEffect(() => {
    const tickTimer = setInterval(() => setCurrentTime(Date.now()), intervalMs)
    return () => clearInterval(tickTimer)
  }, [intervalMs])
  return currentTime
}

function ReleaseValue({ label, value, unit }) {
  const formattedValue = formatReleaseValue(value, unit)
  if (formattedValue === null) return null // the service supplied no value for this field
  return (
    <span className="whitespace-nowrap text-muted">
      {label} <span className="text-bone/90 tabular-figures">{formattedValue}</span>
    </span>
  )
}

function ReleaseItem({ release, currentTime }) {
  const impact = IMPACT_PRESENTATION[release.impact] ?? IMPACT_PRESENTATION.low
  const millisecondsUntil = release.releaseTime.getTime() - currentTime
  const isImminent = millisecondsUntil <= 15 * 60_000

  return (
    <li className="flex shrink-0 items-center gap-2.5 border-r border-divider px-4 text-[12px] last:border-r-0">
      <span className="flex items-center gap-1.5">
        <span aria-hidden="true" className={cn('size-1.5 rounded-full', impact.dotClass)} />
        <span className={cn('text-[10px] font-medium tracking-wider uppercase', impact.textClass)}>
          {impact.label}
          <span className="sr-only"> impact</span>
        </span>
      </span>
      <time dateTime={release.time} className="whitespace-nowrap text-muted tabular-figures">
        {formatReleaseTime(release.releaseTime)}
      </time>
      <span className="whitespace-nowrap text-bone">
        <span className="mr-1.5 text-[10px] font-semibold tracking-wider text-muted">{release.country}</span>
        {release.event}
      </span>
      <ReleaseValue label="Est" value={release.estimate} unit={release.unit} />
      <ReleaseValue label="Prev" value={release.previous} unit={release.unit} />
      <ReleaseValue label="Act" value={release.actual} unit={release.unit} />
      <span
        className={cn(
          'min-w-[4.5rem] text-right whitespace-nowrap tabular-figures',
          isImminent ? 'text-accent' : 'text-muted',
        )}
        aria-label={`Releases in ${formatCountdown(millisecondsUntil)}`}
      >
        {formatCountdown(millisecondsUntil)}
      </span>
    </li>
  )
}

/**
 * Compact strip of upcoming macro releases from the service's economic calendar.
 * Times are shown in the local time zone (labelled); values appear only when supplied.
 */
export default function CatalystFeed() {
  const [minimumImpact, setMinimumImpact] = useState('medium')
  const calendar = useEconomicCalendar({ minimumImpact })
  const currentTime = useCurrentTime(1_000)
  const scrollContainerRef = useRef(null)
  const timeZoneLabel = useMemo(() => localTimeZoneLabel(), [])

  const upcomingReleases = useMemo(
    () => calendar.events.filter((release) => release.releaseTime.getTime() >= currentTime),
    [calendar.events, currentTime],
  )

  const scrollReleases = (direction) => {
    const scrollContainer = scrollContainerRef.current
    if (!scrollContainer) return
    scrollContainer.scrollBy({ left: direction * scrollContainer.clientWidth * 0.8, behavior: 'smooth' })
  }

  let feedBody
  if (calendar.status === 'loading') {
    feedBody = <p className="px-4 text-[12px] text-muted">Loading economic calendar…</p>
  } else if (calendar.status === 'unavailable') {
    feedBody = (
      <p className="flex items-center gap-2 px-4 text-[12px] text-muted">
        <span className="font-medium text-loss">Feed unavailable</span>
        <span aria-hidden="true">·</span>
        <span>{describeFeedError(calendar.error)}</span>
        {calendar.error?.code === 'engine_unreachable' && (
          <EngineStartHint />
        )}
      </p>
    )
  } else if (upcomingReleases.length === 0) {
    feedBody = (
      <p className="px-4 text-[12px] text-muted">
        No upcoming {minimumImpact === 'high' ? 'high-impact ' : ''}releases in the next 7 days.
      </p>
    )
  } else {
    feedBody = (
      <ul
        ref={scrollContainerRef}
        tabIndex={0}
        aria-label={`Upcoming macro releases, ${upcomingReleases.length} items. Use arrow keys to scroll.`}
        className="scrollbar-hidden flex min-w-0 flex-1 items-center overflow-x-auto"
      >
        {upcomingReleases.map((release) => (
          <ReleaseItem key={release.id} release={release} currentTime={currentTime} />
        ))}
      </ul>
    )
  }

  const showScrollButtons = calendar.status === 'ready' && upcomingReleases.length > 0

  return (
    <section
      aria-label="Macro catalysts"
      className="flex h-11 shrink-0 items-center border-b border-divider bg-surface"
    >
      <div className="flex h-full shrink-0 flex-col justify-center border-r border-divider px-4">
        <span className="font-serif text-[15px] leading-none font-semibold text-bone">Catalysts</span>
        <span className="mt-0.5 text-[10px] text-muted" title="Release times are shown in this time zone">
          {timeZoneLabel}
        </span>
      </div>

      <div className="flex min-w-0 flex-1 items-center">{feedBody}</div>

      {showScrollButtons && (
        <div className="flex shrink-0 items-center border-l border-divider">
          <button
            type="button"
            aria-label="Scroll releases left"
            onClick={() => scrollReleases(-1)}
            className="grid h-11 w-8 place-items-center text-muted hover:text-bone"
          >
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Scroll releases right"
            onClick={() => scrollReleases(1)}
            className="grid h-11 w-8 place-items-center text-muted hover:text-bone"
          >
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="flex h-full shrink-0 items-center gap-3 border-l border-divider px-3">
        <div role="radiogroup" aria-label="Minimum impact" className="flex rounded border border-divider p-0.5">
          {IMPACT_FILTERS.map((impactFilter) => (
            <button
              key={impactFilter.value}
              type="button"
              role="radio"
              aria-checked={minimumImpact === impactFilter.value}
              onClick={() => setMinimumImpact(impactFilter.value)}
              className={cn(
                'rounded-sm px-2 py-0.5 text-[11px]',
                minimumImpact === impactFilter.value ? 'bg-surface-raised text-bone' : 'text-muted hover:text-bone',
              )}
            >
              {impactFilter.label}
            </button>
          ))}
        </div>
        <div className="flex min-w-[6.5rem] flex-col items-end text-[10px] leading-tight">
          {calendar.isStale ? (
            <span className="font-medium text-caution" title={describeFeedError(calendar.error)}>
              Stale · {formatClockTime(calendar.lastUpdatedAt)}
            </span>
          ) : (
            <span className="text-muted tabular-figures">
              {calendar.lastUpdatedAt ? `Updated ${formatClockTime(calendar.lastUpdatedAt)}` : ' '}
            </span>
          )}
          {calendar.isStale && <span className="text-muted">{describeFeedError(calendar.error)}</span>}
        </div>
        <button
          type="button"
          aria-label="Refresh economic calendar"
          onClick={calendar.refresh}
          className="grid size-7 place-items-center rounded text-muted hover:bg-surface-raised hover:text-bone"
        >
          <RefreshCw size={13} aria-hidden="true" className={cn(calendar.isRefreshing && 'motion-safe:animate-spin')} />
        </button>
      </div>
    </section>
  )
}
