import { useEffect, useMemo, useState } from 'react'

import { useChartInsights } from '../hooks/useChartInsights.js'
import { useEconomicCalendar } from '../hooks/useEconomicCalendar.js'
import { useSymbolSentiment } from '../hooks/useSymbolSentiment.js'
import { cn } from '../lib/cn.js'
import { formatClockTime, formatCountdown } from '../lib/format.js'
import { describeInstrument, relevantReleases } from '../lib/marketContext.js'
import { explainSizingResult } from '../lib/riskExplanation.js'
import { SIGNAL_LABELS, describeBiasForRisk } from '../lib/signalExplanation.js'

const BIAS_CLASS = { bullish: 'text-gain', bearish: 'text-loss', neutral: 'text-bone' }
const BIAS_DOT_CLASS = { bullish: 'bg-gain', bearish: 'bg-loss', neutral: 'bg-muted' }
const IMPACT_DOT_CLASS = { high: 'bg-impact-high', medium: 'bg-impact-medium', low: 'bg-impact-low' }
const FEED_REASONS = {
  engine_unreachable: 'Engine offline',
  finnhub_not_configured: 'Needs your Finnhub key (Add key in the catalyst strip)',
  finnhub_premium_required: 'Needs a paid Finnhub plan',
  finnhub_unauthorized: 'Finnhub rejected the API key',
  finnhub_rate_limited: 'Finnhub rate limit; retrying',
  finnhub_unavailable: 'Finnhub unreachable',
}

function useCurrentTime(intervalMs) {
  const [currentTime, setCurrentTime] = useState(() => Date.now())
  useEffect(() => {
    const tickTimer = setInterval(() => setCurrentTime(Date.now()), intervalMs)
    return () => clearInterval(tickTimer)
  }, [intervalMs])
  return currentTime
}

function InsightSection({ title, source, children }) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-divider bg-obsidian p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[10px] font-medium tracking-[0.14em] text-muted uppercase">{title}</h3>
        {source && <span className="truncate text-[10px] text-muted/80">{source}</span>}
      </div>
      {children}
    </section>
  )
}

const MARKET_SYMBOL_SOURCES = {
  window_title: 'From the chart window title',
  pair: 'Chosen pair · prices from Yahoo Finance',
}

function MutedLine({ children }) {
  return <p className="text-[12px] text-muted">{children}</p>
}

/**
 * The drawer's Insights tab: what is being watched, which technical analysis is applied,
 * which upcoming releases could move it, news sentiment, and what the last sizing means.
 */
export default function InsightsPanel({ sizingResult }) {
  const { chartInsights } = useChartInsights()
  const instrument = useMemo(
    () => describeInstrument(chartInsights.symbol, chartInsights.assetKind),
    [chartInsights.symbol, chartInsights.assetKind],
  )
  const calendar = useEconomicCalendar({ minimumImpact: 'medium' })
  const sentimentState = useSymbolSentiment(chartInsights.symbol)
  const currentTime = useCurrentTime(1_000)
  const upcomingReleases = useMemo(
    () => relevantReleases(calendar.events, instrument, currentTime).slice(0, 4),
    [calendar.events, instrument, currentTime],
  )
  const highImpactCount = upcomingReleases.filter((release) => release.impact === 'high').length
  const summary = chartInsights.summary
  const dataSourceLabel =
    {
      screen: 'Your screen · relative scale',
      market: `${chartInsights.sourceName ?? 'Live prices'} · Yahoo Finance`,
      file: chartInsights.sourceName,
    }[chartInsights.dataOrigin] ?? null

  return (
    <div className="flex flex-col gap-3">
      <InsightSection title="Market" source={MARKET_SYMBOL_SOURCES[chartInsights.symbolSource] ?? null}>
        {instrument.symbol ? (
          <div className="flex items-baseline justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-serif text-[22px] leading-none font-semibold text-bone">{instrument.symbol}</p>
              <p className="mt-1 truncate text-[11px] text-muted">
                {[chartInsights.instrumentName, instrument.description].filter(Boolean).join(' · ')}
              </p>
            </div>
            {chartInsights.titleLastPrice && (
              <div className="shrink-0 text-right tabular-figures">
                <p className="text-[15px] text-bone">{chartInsights.titleLastPrice}</p>
                {chartInsights.titleChange && (
                  <p
                    className={cn(
                      'text-[11px]',
                      chartInsights.titleDirection === 'up' && 'text-gain',
                      chartInsights.titleDirection === 'down' && 'text-loss',
                    )}
                  >
                    {chartInsights.titleDirection === 'up' ? '▲ ' : chartInsights.titleDirection === 'down' ? '▼ ' : ''}
                    {chartInsights.titleChange}
                  </p>
                )}
              </div>
            )}
          </div>
        ) : (
          <MutedLine>Symbol not detected. It is read from your chart window’s title.</MutedLine>
        )}
      </InsightSection>

      <InsightSection title="Technical analysis" source={dataSourceLabel}>
        {summary ? (
          <>
            <p className="text-[13px] text-bone">
              Reading{' '}
              <span className={cn('font-medium capitalize', BIAS_CLASS[summary.bias])}>{summary.bias}</span>
              <span className="text-muted">
                {' '}
                · {summary.score > 0 ? '+' : ''}
                {summary.score} of 5
              </span>
            </p>
            <ul className="flex flex-col gap-1">
              {summary.signals.map((signal) => (
                <li key={signal.name} className="flex items-center gap-2 text-[11px]" title={signal.detail}>
                  <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', BIAS_DOT_CLASS[signal.bias])} />
                  <span className="flex-1 truncate text-bone/90">{SIGNAL_LABELS[signal.name] ?? signal.name}</span>
                  <span className={cn('shrink-0 capitalize', BIAS_CLASS[signal.bias])}>{signal.bias}</span>
                </li>
              ))}
            </ul>
            <p className="text-[11px] leading-snug text-muted">{describeBiasForRisk(summary.bias)}</p>
          </>
        ) : (
          <MutedLine>No chart data yet.</MutedLine>
        )}
      </InsightSection>

      <InsightSection
        title={instrument.countries.length ? `Upcoming · ${instrument.countries.join(', ')}` : 'Upcoming releases'}
        source="Finnhub"
      >
        {calendar.status === 'unavailable' ? (
          <MutedLine>{FEED_REASONS[calendar.error?.code] ?? 'Calendar unavailable'}</MutedLine>
        ) : upcomingReleases.length === 0 ? (
          <MutedLine>{calendar.status === 'loading' ? 'Loading…' : 'Nothing relevant in the next 24 hours.'}</MutedLine>
        ) : (
          <>
            <ul className="flex flex-col gap-1">
              {upcomingReleases.map((release) => (
                <li key={release.id} className="flex items-center gap-2 text-[11px]">
                  <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', IMPACT_DOT_CLASS[release.impact])} />
                  <span className="shrink-0 text-[10px] font-semibold text-muted">{release.country}</span>
                  <span className="flex-1 truncate text-bone/90">{release.event}</span>
                  <span className="shrink-0 text-muted tabular-figures">
                    {formatCountdown(release.releaseTime.getTime() - currentTime)}
                  </span>
                </li>
              ))}
            </ul>
            {highImpactCount > 0 && (
              <p className="text-[11px] leading-snug text-caution">
                {highImpactCount} high-impact release{highImpactCount > 1 ? 's' : ''} ahead: prices can jump and stops can
                fill beyond their level.
              </p>
            )}
          </>
        )}
      </InsightSection>

      <InsightSection
        title="News sentiment"
        source={sentimentState.sentiment ? (sentimentState.sentiment.source === 'finnhub' ? 'Finnhub' : 'Headline scoring') : null}
      >
        {!instrument.symbol ? (
          <MutedLine>Shown once a symbol is detected.</MutedLine>
        ) : sentimentState.status === 'ready' ? (
          <div className="flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-raised" aria-hidden="true">
              <div
                className={cn('h-full rounded-full', sentimentState.sentiment.score >= 0 ? 'bg-gain' : 'bg-loss')}
                style={{ width: `${Math.round(Math.abs(sentimentState.sentiment.score) * 100)}%` }}
              />
            </div>
            <span className={cn('text-[12px] capitalize', BIAS_CLASS[sentimentState.sentiment.label])}>
              {sentimentState.sentiment.label}
            </span>
            <span className="text-[11px] text-muted tabular-figures">
              {sentimentState.sentiment.articles_analysed} articles
            </span>
          </div>
        ) : (
          <MutedLine>
            {sentimentState.status === 'loading'
              ? 'Loading…'
              : (FEED_REASONS[sentimentState.error?.code] ?? 'Not available for this symbol')}
          </MutedLine>
        )}
      </InsightSection>

      <InsightSection title="Your last sizing" source={sizingResult ? 'Maison engine' : null}>
        {sizingResult ? (
          <ul className="flex flex-col gap-1.5">
            {explainSizingResult(sizingResult).map((explanation) => (
              <li
                key={explanation.key}
                className={cn('text-[11px] leading-snug', explanation.tone === 'caution' ? 'text-caution' : 'text-bone/85')}
              >
                {explanation.text}
              </li>
            ))}
          </ul>
        ) : (
          <MutedLine>Calculate a position on the Size tab to see what it risks.</MutedLine>
        )}
      </InsightSection>

      <p className="text-center text-[10px] text-muted/80">
        {chartInsights.computedAt ? `Indicators computed ${formatClockTime(chartInsights.computedAt)} · ` : ''}Analysis
        aid, not financial advice.
      </p>
    </div>
  )
}
