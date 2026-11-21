import { AlertTriangle, FileUp, LoaderCircle, RotateCcw } from 'lucide-react'
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
} from 'lightweight-charts'
import { useEffect, useMemo, useRef } from 'react'

import { ENGINE_START_COMMAND, MAX_CANDLES_PER_REQUEST } from '../config.js'
import { useIndicatorWorkspace } from '../hooks/useIndicatorWorkspace.js'
import { useTerminalSocket } from '../hooks/useTerminalSocket.js'
import { CandleFileError } from '../lib/candles.js'
import { cn } from '../lib/cn.js'
import { formatClockTime } from '../lib/format.js'

const PALETTE = {
  obsidian: '#0D0D0E',
  divider: '#222226',
  gridLine: '#17171A',
  bone: '#F4F4F6',
  muted: '#8E8E93',
  gain: '#00C805',
  loss: '#EF4444',
  accent: '#00C805',
}

/** Series colours keyed by exact column name first, then by column prefix. */
const SERIES_COLOR_BY_KEY = {
  EMA_9: PALETTE.accent,
  EMA_21: 'rgba(244, 244, 246, 0.78)',
  EMA_50: '#8E8E93',
  EMA_200: '#6F7FA3',
}
const SERIES_COLOR_BY_PREFIX = [
  ['BBU_', 'rgba(142, 142, 147, 0.55)'],
  ['BBM_', 'rgba(142, 142, 147, 0.35)'],
  ['BBL_', 'rgba(142, 142, 147, 0.55)'],
  ['RSI_', PALETTE.accent],
  ['MACDs_', PALETTE.accent],
  ['MACD_', 'rgba(244, 244, 246, 0.85)'],
]
const FALLBACK_SERIES_COLORS = ['#B8A07E', '#7FA7A0', '#A88FB8', '#C9C9CF']
/** Bollinger bandwidth and %B are not price-denominated; plotting them would distort the price axis. */
const NON_PRICE_SERIES_PREFIXES = ['BBB_', 'BBP_']

function colorForSeries(seriesKey, fallbackIndex) {
  if (SERIES_COLOR_BY_KEY[seriesKey]) return SERIES_COLOR_BY_KEY[seriesKey]
  const prefixMatch = SERIES_COLOR_BY_PREFIX.find(([prefix]) => seriesKey.startsWith(prefix))
  return prefixMatch ? prefixMatch[1] : FALLBACK_SERIES_COLORS[fallbackIndex % FALLBACK_SERIES_COLORS.length]
}

function isPlottableSeries(indicator, series) {
  if (series.data.length === 0) return false
  if (indicator.pane === 'price' && NON_PRICE_SERIES_PREFIXES.some((prefix) => series.key.startsWith(prefix))) {
    return false
  }
  return true
}

/** Legend entries derived from the service response (what is actually plotted). */
function buildLegendEntries(chartData) {
  if (!chartData) return []
  const legendEntries = []
  let fallbackIndex = 0
  for (const indicator of chartData.indicators) {
    for (const series of indicator.series) {
      if (!isPlottableSeries(indicator, series) || series.style === 'histogram') continue
      legendEntries.push({ key: series.key, color: colorForSeries(series.key, fallbackIndex), pane: indicator.pane })
      fallbackIndex += 1
    }
  }
  return legendEntries
}

const BASE_CHART_OPTIONS = {
  layout: {
    background: { type: ColorType.Solid, color: PALETTE.obsidian },
    textColor: PALETTE.muted,
    fontFamily: '"Inter Variable", "Segoe UI", sans-serif',
    fontSize: 11,
    attributionLogo: true, // required TradingView attribution; do not remove
    panes: { separatorColor: PALETTE.divider, separatorHoverColor: 'rgba(0, 200, 5, 0.25)' },
  },
  grid: {
    vertLines: { color: PALETTE.gridLine },
    horzLines: { color: PALETTE.gridLine },
  },
  crosshair: {
    mode: CrosshairMode.Normal,
    vertLine: { color: 'rgba(244, 244, 246, 0.25)', labelBackgroundColor: '#26262B' },
    horzLine: { color: 'rgba(244, 244, 246, 0.25)', labelBackgroundColor: '#26262B' },
  },
  rightPriceScale: { borderColor: PALETTE.divider },
  timeScale: { borderColor: PALETTE.divider, rightOffset: 4 },
}

/**
 * Replace every series with the service's latest response.
 * The viewport is fitted only for a newly loaded dataset; otherwise the user's
 * historical range is restored exactly.
 */
function renderChartData(chart, chartData, { fitToContent }) {
  const preservedLogicalRange = fitToContent ? null : chart.timeScale().getVisibleLogicalRange()

  for (const pane of chart.panes()) {
    for (const existingSeries of pane.getSeries()) chart.removeSeries(existingSeries)
  }
  for (let paneIndex = chart.panes().length - 1; paneIndex > 0; paneIndex -= 1) chart.removePane(paneIndex)

  const isIntradayData = typeof chartData.candles[0]?.time === 'number'
  chart.applyOptions({ timeScale: { timeVisible: isIntradayData, secondsVisible: false } })

  const candleSeries = chart.addSeries(CandlestickSeries, {
    upColor: 'rgba(0, 200, 5, 0.16)',
    downColor: 'rgba(239, 68, 68, 0.85)',
    borderUpColor: PALETTE.gain,
    borderDownColor: PALETTE.loss,
    wickUpColor: PALETTE.gain,
    wickDownColor: PALETTE.loss,
    priceLineColor: PALETTE.muted,
  })
  candleSeries.setData(chartData.candles)

  if (chartData.volume && chartData.volume.length > 0) {
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: 'volume',
      priceFormat: { type: 'volume' },
      color: 'rgba(142, 142, 147, 0.22)',
      lastValueVisible: false,
      priceLineVisible: false,
    })
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
    volumeSeries.setData(chartData.volume)
  }

  let nextOscillatorPaneIndex = 1
  let fallbackColorIndex = 0
  for (const indicator of chartData.indicators) {
    const plottableSeries = indicator.series.filter((series) => isPlottableSeries(indicator, series))
    if (plottableSeries.length === 0) continue
    const targetPaneIndex = indicator.pane === 'price' ? 0 : nextOscillatorPaneIndex++
    let firstSeriesInIndicator = null

    for (const series of plottableSeries) {
      let chartSeries
      if (series.style === 'histogram') {
        chartSeries = chart.addSeries(
          HistogramSeries,
          { priceLineVisible: false, lastValueVisible: false },
          targetPaneIndex,
        )
        // Sign colouring is presentation only; values are exactly the service's.
        chartSeries.setData(
          series.data.map((point) => ({
            ...point,
            color: point.value >= 0 ? 'rgba(0, 200, 5, 0.55)' : 'rgba(239, 68, 68, 0.55)',
          })),
        )
      } else {
        const isBand = /^BB[ULM]_/.test(series.key)
        chartSeries = chart.addSeries(
          LineSeries,
          {
            color: colorForSeries(series.key, fallbackColorIndex),
            lineWidth: 1,
            lineStyle: isBand ? LineStyle.Dashed : LineStyle.Solid,
            priceLineVisible: false,
            lastValueVisible: !isBand,
            crosshairMarkerVisible: false,
            title: indicator.pane === 'price' ? '' : series.key,
          },
          targetPaneIndex,
        )
        chartSeries.setData(series.data)
        fallbackColorIndex += 1
      }
      firstSeriesInIndicator ??= chartSeries
    }

    for (const referencePrice of indicator.reference_lines ?? []) {
      firstSeriesInIndicator.createPriceLine({
        price: referencePrice,
        color: 'rgba(142, 142, 147, 0.45)',
        lineStyle: LineStyle.Dotted,
        lineWidth: 1,
        axisLabelVisible: true,
        title: '',
      })
    }
  }

  const chartPanes = chart.panes()
  chartPanes[0]?.setStretchFactor(3)
  for (const oscillatorPane of chartPanes.slice(1)) oscillatorPane.setStretchFactor(1)

  if (fitToContent) {
    chart.timeScale().fitContent()
  } else if (preservedLogicalRange) {
    chart.timeScale().setVisibleLogicalRange(preservedLogicalRange)
  }
}

function describeWorkspaceError(workspaceError) {
  if (!workspaceError) return ''
  if (workspaceError instanceof CandleFileError) return workspaceError.message
  if (workspaceError.code === 'validation_error' && Array.isArray(workspaceError.details)) {
    const firstProblem = workspaceError.details[0]
    const location = firstProblem?.loc ?? []
    const candlePosition = typeof location[2] === 'number' ? location[2] + 1 : null
    const problemText = String(firstProblem?.msg ?? 'invalid value').replace(/^Value error, /, '')
    return candlePosition
      ? `Candle ${candlePosition} (in time order) was rejected by the service: ${problemText}.`
      : `The service rejected the data: ${problemText}.`
  }
  if (workspaceError.code === 'engine_unreachable') {
    return 'The analytical service is offline. The chart will load automatically once it connects.'
  }
  return workspaceError.message
}

function ChartStatePanel({ icon, title, children }) {
  return (
    <div className="absolute inset-0 z-10 grid place-items-center bg-obsidian/85 p-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        {icon}
        <h2 className="font-serif text-[22px] leading-tight font-semibold text-bone">{title}</h2>
        {children}
      </div>
    </div>
  )
}

function OpenFileButton({ onClick, variant = 'primary' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-2 rounded px-3 py-1.5 text-[12px] font-medium transition-colors',
        variant === 'primary'
          ? 'border border-accent/50 text-bone hover:border-accent hover:bg-accent/10'
          : 'border border-divider text-muted hover:border-muted hover:text-bone',
      )}
    >
      <FileUp size={13} aria-hidden="true" />
      Open CSV export…
    </button>
  )
}

/**
 * Primary workspace: TradingView Lightweight Charts rendering the candles and pandas-ta
 * series returned by the analytical service.
 */
export default function ChartCanvas() {
  const workspace = useIndicatorWorkspace()
  const { isConnected } = useTerminalSocket()
  const chartContainerRef = useRef(null)
  const chartRef = useRef(null)
  const fileInputRef = useRef(null)
  const renderedDatasetVersionRef = useRef(0)

  // Create the chart once; resize with the container while keeping the user's viewport.
  useEffect(() => {
    const chartContainer = chartContainerRef.current
    const chart = createChart(chartContainer, {
      ...BASE_CHART_OPTIONS,
      width: chartContainer.clientWidth,
      height: chartContainer.clientHeight,
    })
    chartRef.current = chart

    const resizeObserver = new ResizeObserver(([containerEntry]) => {
      const { width, height } = containerEntry.contentRect
      const visibleLogicalRange = chart.timeScale().getVisibleLogicalRange()
      chart.resize(Math.floor(width), Math.floor(height))
      if (visibleLogicalRange) chart.timeScale().setVisibleLogicalRange(visibleLogicalRange)
    })
    resizeObserver.observe(chartContainer)

    return () => {
      resizeObserver.disconnect()
      chart.remove()
      chartRef.current = null
      renderedDatasetVersionRef.current = 0
    }
  }, [])

  // Draw whatever the service returned; fit only when a new file was loaded.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !workspace.chartData) return
    const isNewDataset = workspace.datasetVersion !== renderedDatasetVersionRef.current
    renderChartData(chart, workspace.chartData, { fitToContent: isNewDataset })
    renderedDatasetVersionRef.current = workspace.datasetVersion
  }, [workspace.chartData, workspace.datasetVersion])

  const legendEntries = useMemo(() => buildLegendEntries(workspace.chartData), [workspace.chartData])
  const openFilePicker = () => fileInputRef.current?.click()
  const handleFileChosen = (changeEvent) => {
    const chosenFile = changeEvent.target.files?.[0]
    changeEvent.target.value = '' // allow re-opening the same file
    workspace.loadCandleFile(chosenFile)
  }

  const hasChartData = workspace.chartData !== null
  const isBusy = workspace.status === 'parsing' || workspace.status === 'computing'
  const isStale = hasChartData && !isConnected
  const summary = workspace.chartData?.summary
  const fileNotice = workspace.fileNotice
  const canRetryFailure = workspace.status === 'failed' && workspace.canRetry && workspace.error?.isRecoverable

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-4 border-b border-divider px-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <h1
            className="max-w-[18rem] truncate font-serif text-[17px] leading-none font-semibold text-bone"
            title={workspace.sourceName ?? undefined}
          >
            {workspace.sourceName ?? 'Chart'}
          </h1>
          {fileNotice && hasChartData && (
            <span className="truncate text-[11px] text-muted tabular-figures">
              {fileNotice.candleCount.toLocaleString()} bars
              {fileNotice.truncatedRowCount > 0 &&
                ` · most recent ${MAX_CANDLES_PER_REQUEST.toLocaleString()} (service limit)`}
              {fileNotice.skippedRowCount > 0 && ` · ${fileNotice.skippedRowCount} unreadable rows skipped`}
            </span>
          )}
        </div>

        {legendEntries.length > 0 && (
          <ul aria-label="Plotted indicator series" className="hidden min-w-0 items-center gap-3 overflow-hidden lg:flex">
            {legendEntries.map((legendEntry) => (
              <li key={legendEntry.key} className="flex items-center gap-1.5 text-[11px] whitespace-nowrap text-muted">
                <span aria-hidden="true" className="h-px w-3" style={{ backgroundColor: legendEntry.color, height: 2 }} />
                {legendEntry.key}
              </li>
            ))}
          </ul>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-3">
          {summary && (
            <span
              className="text-[11px] text-muted"
              title={summary.signals.map((signal) => `${signal.name}: ${signal.detail}`).join('\n')}
            >
              Python signal{' '}
              <span
                className={cn(
                  'font-medium capitalize',
                  summary.bias === 'bullish' && 'text-gain',
                  summary.bias === 'bearish' && 'text-loss',
                  summary.bias === 'neutral' && 'text-bone',
                )}
              >
                {summary.bias} ({summary.score > 0 ? '+' : ''}
                {summary.score})
              </span>
            </span>
          )}
          {isBusy && hasChartData && (
            <span className="flex items-center gap-1.5 text-[11px] text-muted" role="status">
              <LoaderCircle size={12} aria-hidden="true" className="motion-safe:animate-spin" /> Computing…
            </span>
          )}
          {isStale && (
            <span className="text-[11px] font-medium text-caution" role="status">
              Engine offline · series from {formatClockTime(workspace.computedAt)}
            </span>
          )}
          {hasChartData && <OpenFileButton onClick={openFilePicker} variant="secondary" />}
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            aria-label="Open price history CSV export"
            onChange={handleFileChosen}
          />
        </div>
      </div>

      {workspace.status === 'failed' && hasChartData && (
        <div role="alert" className="flex items-center gap-3 border-b border-loss/30 bg-loss/10 px-4 py-2 text-[12px] text-bone">
          <AlertTriangle size={13} aria-hidden="true" className="shrink-0 text-loss" />
          <span className="min-w-0 flex-1">{describeWorkspaceError(workspace.error)}</span>
          {canRetryFailure && (
            <button type="button" onClick={workspace.retry} className="text-accent hover:underline">
              Retry
            </button>
          )}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={chartContainerRef} className="absolute inset-0" data-testid="chart-container" />

        {workspace.status === 'empty' && (
          <ChartStatePanel title="No price history connected">
            <p className="text-[13px] leading-relaxed text-muted">
              The analytical service doesn’t provide a price-history endpoint yet. Open a CSV export from
              your broker and the service will compute the indicators for it.
            </p>
            <p className="text-[11px] text-muted">
              Columns: <span className="text-bone/80">time, open, high, low, close</span> (volume optional).
              Daily dates (YYYY-MM-DD) or timestamps.
            </p>
            <OpenFileButton onClick={openFilePicker} />
          </ChartStatePanel>
        )}

        {isBusy && !hasChartData && (
          <ChartStatePanel
            icon={<LoaderCircle size={22} aria-hidden="true" className="text-accent motion-safe:animate-spin" />}
            title={workspace.status === 'parsing' ? 'Reading file…' : 'Computing indicators…'}
          >
            <p className="text-[12px] text-muted" role="status">
              {workspace.sourceName}
            </p>
          </ChartStatePanel>
        )}

        {workspace.status === 'failed' && !hasChartData && (
          <ChartStatePanel
            icon={<AlertTriangle size={22} aria-hidden="true" className="text-loss" />}
            title="Couldn’t load the chart"
          >
            <p role="alert" className="text-[13px] leading-relaxed text-muted">
              {describeWorkspaceError(workspace.error)}
            </p>
            {workspace.error?.code === 'engine_unreachable' && (
              <code className="rounded bg-surface-raised px-2 py-1 text-[11px] text-bone/80" data-selectable>
                {ENGINE_START_COMMAND}
              </code>
            )}
            <div className="flex items-center gap-2">
              {canRetryFailure && (
                <button
                  type="button"
                  onClick={workspace.retry}
                  className="inline-flex items-center gap-2 rounded border border-accent/50 px-3 py-1.5 text-[12px] font-medium text-bone hover:border-accent hover:bg-accent/10"
                >
                  <RotateCcw size={13} aria-hidden="true" /> Retry
                </button>
              )}
              <OpenFileButton onClick={openFilePicker} variant={canRetryFailure ? 'secondary' : 'primary'} />
            </div>
          </ChartStatePanel>
        )}
      </div>
    </div>
  )
}
