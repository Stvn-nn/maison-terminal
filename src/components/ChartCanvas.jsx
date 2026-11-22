import { AlertTriangle, EyeOff, FileUp, Info, LoaderCircle, RotateCcw, ScanEye } from 'lucide-react'
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
} from 'lightweight-charts'
import { useEffect, useMemo, useRef, useState } from 'react'

import {
  MAX_CANDLES_PER_REQUEST,
  RELATIVE_SCALE_FLOOR,
  SCREEN_BAR_SECONDS,
  SCREEN_TIME_ORIGIN,
} from '../config.js'
import maisonLogo from '../assets/maison-logo.png'
import { useChartInsights } from '../hooks/useChartInsights.js'
import { useChartWatch } from '../hooks/useChartWatch.js'
import { useIndicatorWorkspace } from '../hooks/useIndicatorWorkspace.js'
import { useMarketChart } from '../hooks/useMarketChart.js'
import { useScreenChart } from '../hooks/useScreenChart.js'
import { useResolvedSymbol } from '../hooks/useSymbolSearch.js'
import { useTerminalSocket } from '../hooks/useTerminalSocket.js'
import { CandleFileError } from '../lib/candles.js'
import { cn } from '../lib/cn.js'
import { formatClockTime } from '../lib/format.js'
import { DEFAULT_TIMEFRAME, TIMEFRAMES, displaySymbol } from '../lib/marketSymbols.js'
import EngineStartHint from './EngineStartHint.jsx'
import PairSearch, { AssetKindIcon } from './PairSearch.jsx'
import SegmentedControl from './SegmentedControl.jsx'
import SignalPanel from './SignalPanel.jsx'
import TimeframeBar from './TimeframeBar.jsx'

const CHART_SOURCES = [
  {
    value: 'screen',
    label: 'Screen',
    description: 'Follow the chart on your screen (live prices once its symbol is recognised)',
  },
  { value: 'pair', label: 'Pair', description: 'Search for any pair or symbol and chart its live prices' },
  { value: 'file', label: 'CSV file', description: 'Load real prices from a broker CSV export' },
]

function screenBarNumber(chartTime) {
  return Math.round((chartTime - SCREEN_TIME_ORIGIN) / SCREEN_BAR_SECONDS) + 1
}

function formatDefaultTimeLabel(chartTime) {
  const dateOptions = { timeZone: 'UTC', dateStyle: 'medium' }
  if (typeof chartTime === 'number') {
    return new Date(chartTime * 1000).toLocaleString(undefined, { ...dateOptions, timeStyle: 'short' })
  }
  if (typeof chartTime === 'string') return new Date(`${chartTime}T00:00:00Z`).toLocaleDateString(undefined, dateOptions)
  if (chartTime && typeof chartTime === 'object') {
    return new Date(Date.UTC(chartTime.year, chartTime.month - 1, chartTime.day)).toLocaleDateString(undefined, dateOptions)
  }
  return String(chartTime)
}

const PALETTE = {
  obsidian: '#0D0D0E',
  divider: '#222226',
  gridLine: '#17171A',
  bone: '#F4F4F6',
  muted: '#8E8E93',
  gain: '#00C805',
  loss: '#EF4444',
  accent: '#6A86B0',
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
    panes: { separatorColor: PALETTE.divider, separatorHoverColor: 'rgba(106, 134, 176, 0.3)' },
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
/** Remove every series and extra pane (used when the selected source has no data yet). */
function clearChart(chart) {
  for (const pane of chart.panes()) {
    for (const existingSeries of pane.getSeries()) chart.removeSeries(existingSeries)
  }
  for (let paneIndex = chart.panes().length - 1; paneIndex > 0; paneIndex -= 1) chart.removePane(paneIndex)
}

/** Screen-read candles sit on 100..200; show them as 0..100 (% of the chart's height). */
const RELATIVE_PRICE_FORMAT = {
  type: 'custom',
  minMove: 0.1,
  formatter: (relativeValue) => (relativeValue - RELATIVE_SCALE_FLOOR).toFixed(1),
}

/** Bars currently drawn on each chart, to tell how many arrived since the last render. */
const renderedBarCounts = new WeakMap()

/** Enough decimals to see moves: EURUSD 1.09745 needs 5, SPX 6910.39 needs 2. */
function priceFormatForLevel(priceLevel) {
  let precision = 2
  if (priceLevel < 1) precision = 6
  else if (priceLevel < 10) precision = 5
  else if (priceLevel < 100) precision = 3
  return { type: 'price', precision, minMove: 10 ** -precision }
}

function renderChartData(chart, chartData, { fitToContent, isRelativeScale }) {
  const preservedLogicalRange = fitToContent ? null : chart.timeScale().getVisibleLogicalRange()
  const previousBarCount = renderedBarCounts.get(chart) ?? 0
  renderedBarCounts.set(chart, chartData.candles.length)
  clearChart(chart)

  const isIntradayData = typeof chartData.candles[0]?.time === 'number'
  chart.applyOptions({
    timeScale: { timeVisible: isIntradayData && !isRelativeScale, secondsVisible: false },
  })
  const lastClose = chartData.candles.at(-1)?.close ?? 100
  const pricePaneFormat = { priceFormat: isRelativeScale ? RELATIVE_PRICE_FORMAT : priceFormatForLevel(lastClose) }

  const candleSeries = chart.addSeries(CandlestickSeries, {
    upColor: 'rgba(0, 200, 5, 0.16)',
    downColor: 'rgba(239, 68, 68, 0.85)',
    borderUpColor: PALETTE.gain,
    borderDownColor: PALETTE.loss,
    wickUpColor: PALETTE.gain,
    wickDownColor: PALETTE.loss,
    priceLineColor: PALETTE.muted,
    ...pricePaneFormat,
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
      // MACD is a difference of prices, so it needs the price's decimals (forex: 0.00012).
      const isPriceDenominated = indicator.pane === 'price' || series.key.startsWith('MACD')
      if (series.style === 'histogram') {
        chartSeries = chart.addSeries(
          HistogramSeries,
          { priceLineVisible: false, lastValueVisible: false, ...(isPriceDenominated ? pricePaneFormat : {}) },
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
            ...(isPriceDenominated ? pricePaneFormat : {}),
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
    // Like a live chart: if the user was looking at the latest bar, scroll with new bars.
    const addedBarCount = chartData.candles.length - previousBarCount
    const wasFollowingLatestBar = preservedLogicalRange.to >= previousBarCount - 1.5
    chart.timeScale().setVisibleLogicalRange(
      addedBarCount > 0 && wasFollowingLatestBar
        ? { from: preservedLogicalRange.from + addedBarCount, to: preservedLogicalRange.to + addedBarCount }
        : preservedLogicalRange,
    )
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

const PRIMARY_PILL_CLASS =
  'inline-flex items-center gap-2 rounded-full bg-accent px-3.5 py-1.5 text-[12px] font-semibold text-obsidian shadow-[0_2px_10px_rgba(106,134,176,0.35)] transition-colors hover:bg-accent-strong'

function OpenFileButton({ onClick, variant = 'primary', compact = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open CSV export"
      title="Open a CSV export from your broker"
      className={cn(
        variant === 'primary'
          ? PRIMARY_PILL_CLASS
          : 'inline-flex items-center gap-2 rounded-full border border-accent/40 px-3.5 py-1.5 text-[12px] font-medium text-bone transition-colors hover:border-accent hover:bg-accent/15',
        compact && 'px-2.5',
      )}
    >
      <FileUp size={13} aria-hidden="true" />
      <span className={cn(compact && 'hidden lg:inline')}>Open CSV export…</span>
    </button>
  )
}

const CHART_SOURCE_STORAGE_KEY = 'maison.chartSource'
const SELECTED_PAIR_STORAGE_KEY = 'maison.selectedPair'
const TIMEFRAME_STORAGE_KEY = 'maison.timeframe'

function isKnownChartSource(storedValue) {
  return CHART_SOURCES.some((chartSourceOption) => chartSourceOption.value === storedValue)
}
function isStoredPair(storedValue) {
  return Boolean(storedValue && typeof storedValue.symbol === 'string' && storedValue.symbol)
}
function isKnownTimeframe(storedValue) {
  return TIMEFRAMES.some((timeframeOption) => timeframeOption.value === storedValue)
}

/** useState that survives restarts (localStorage), ignoring stored values that fail `isValid`. */
function useStoredState(storageKey, fallbackValue, isValid) {
  const [storedState, setStoredState] = useState(() => {
    try {
      const rawValue = window.localStorage.getItem(storageKey)
      const parsedValue = rawValue === null ? fallbackValue : JSON.parse(rawValue)
      return isValid(parsedValue) ? parsedValue : fallbackValue
    } catch {
      return fallbackValue
    }
  })
  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(storedState))
    } catch {
      // Storage unavailable (private window): the choice simply isn't remembered.
    }
  }, [storageKey, storedState])
  return [storedState, setStoredState]
}

function timeframeLabel(timeframe) {
  return TIMEFRAMES.find((timeframeOption) => timeframeOption.value === timeframe)?.label ?? timeframe
}

function formatMarketPrice(price) {
  if (typeof price !== 'number' || !Number.isFinite(price)) return null
  const fractionDigits = price >= 1000 ? 2 : price >= 1 ? 4 : 6
  return price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: fractionDigits })
}

/**
 * Primary workspace: TradingView Lightweight Charts rendering the candles and pandas-ta
 * series returned by the analytical service.
 *
 * Sources: Screen (the chart on the user's screen; real, live prices once its symbol is
 * recognised from the window title, otherwise the candle shapes read off the pixels),
 * Pair (any symbol the user searches for, live prices) and CSV file.
 */
export default function ChartCanvas() {
  const workspace = useIndicatorWorkspace()
  const chartWatch = useChartWatch()
  const { isConnected } = useTerminalSocket()
  const [chartSource, setChartSource] = useStoredState(CHART_SOURCE_STORAGE_KEY, 'screen', isKnownChartSource)
  const [selectedPair, setSelectedPair] = useStoredState(SELECTED_PAIR_STORAGE_KEY, null, isStoredPair)
  const [timeframe, setTimeframe] = useStoredState(TIMEFRAME_STORAGE_KEY, DEFAULT_TIMEFRAME, isKnownTimeframe)
  const isScreenSource = chartSource === 'screen'
  const isPairSource = chartSource === 'pair'

  const screenChart = useScreenChart({ enabled: isScreenSource && chartWatch.isWatching })
  const screenSymbolResolution = useResolvedSymbol(isScreenSource && chartWatch.isWatching ? screenChart.symbol : null)
  const marketInstrument = isPairSource ? selectedPair : isScreenSource ? screenSymbolResolution.match : null
  const marketChart = useMarketChart({
    symbol: marketInstrument?.symbol ?? null,
    timeframe,
    enabled: Boolean(marketInstrument),
  })
  // Screen source: real prices for the recognised symbol; pixel-read shapes only as a fallback.
  const isUsingMarketPrices = isPairSource || (isScreenSource && Boolean(marketInstrument) && marketChart.status !== 'error')
  const isWaitingForScreenSymbol = isScreenSource && screenSymbolResolution.isResolving

  const chartContainerRef = useRef(null)
  const chartRef = useRef(null)
  const fileInputRef = useRef(null)
  const renderedDatasetVersionRef = useRef(0)
  const lastFedDatasetKeyRef = useRef(null)
  const lastFedBarCountRef = useRef(0)
  const isRelativeScaleRef = useRef(false)

  // Create the chart once; resize with the container while keeping the user's viewport.
  useEffect(() => {
    const chartContainer = chartContainerRef.current
    const chart = createChart(chartContainer, {
      ...BASE_CHART_OPTIONS,
      localization: {
        timeFormatter: (chartTime) =>
          isRelativeScaleRef.current ? `Bar ${screenBarNumber(chartTime)}` : formatDefaultTimeLabel(chartTime),
      },
      timeScale: {
        ...BASE_CHART_OPTIONS.timeScale,
        // Returning null keeps Lightweight Charts' default date/time tick labels.
        tickMarkFormatter: (chartTime) => (isRelativeScaleRef.current ? `${screenBarNumber(chartTime)}` : null),
      },
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

  // The candles that should be on the chart right now, and which dataset they belong to.
  const marketSourceName = marketInstrument ? `${marketInstrument.symbol} · ${timeframeLabel(timeframe)}` : null
  const liveFeed = useMemo(() => {
    if (isUsingMarketPrices) {
      if (!marketInstrument || marketChart.candles.length < 2) return null
      return {
        dataOrigin: 'market',
        candles: marketChart.candles,
        datasetKey: `${chartSource}|${marketChart.datasetKey}`,
        sourceName: marketSourceName,
      }
    }
    if (isScreenSource && !isWaitingForScreenSymbol && screenChart.status === 'ready' && screenChart.candles.length >= 2) {
      return {
        dataOrigin: 'screen',
        candles: screenChart.candles,
        datasetKey: `screen|${screenChart.symbol ?? ''}`,
        sourceName: 'Your screen',
      }
    }
    return null
  }, [
    isUsingMarketPrices,
    marketInstrument,
    marketChart.candles,
    marketChart.datasetKey,
    marketSourceName,
    chartSource,
    isScreenSource,
    isWaitingForScreenSymbol,
    screenChart.status,
    screenChart.candles,
    screenChart.symbol,
  ])

  // Send new candles to the engine for indicators; refit only when the dataset changes
  // (new symbol, timeframe or source, or a screen chart whose shape changed completely).
  const { loadLiveCandles } = workspace
  useEffect(() => {
    if (!liveFeed) return
    const previousBarCount = lastFedBarCountRef.current
    const barCount = liveFeed.candles.length
    const isScreenReshape =
      liveFeed.dataOrigin === 'screen' && previousBarCount > 0 && Math.abs(barCount - previousBarCount) > 0.25 * previousBarCount
    const isNewDataset = liveFeed.datasetKey !== lastFedDatasetKeyRef.current || isScreenReshape
    lastFedDatasetKeyRef.current = liveFeed.datasetKey
    lastFedBarCountRef.current = barCount
    loadLiveCandles(liveFeed.candles, {
      isNewDataset,
      dataOrigin: liveFeed.dataOrigin,
      chartSource,
      sourceName: liveFeed.sourceName,
    })
  }, [liveFeed, chartSource, loadLiveCandles])

  // Only show data that belongs to the selected source (and, for Pair, the selected pair).
  const isScreenWatchOff = isScreenSource && !chartWatch.isWatching
  const isPairDataCurrent = !isPairSource || (selectedPair !== null && workspace.sourceName === marketSourceName)
  const visibleChartData =
    workspace.loadedForSource === chartSource && !isScreenWatchOff && isPairDataCurrent ? workspace.chartData : null
  const isRelativeScale = visibleChartData !== null && workspace.dataOrigin === 'screen'
  const isShowingMarketPrices = visibleChartData !== null && workspace.dataOrigin === 'market'

  // Draw whatever the service returned; fit only when a new dataset was loaded.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    isRelativeScaleRef.current = isRelativeScale
    if (!visibleChartData) {
      clearChart(chart)
      return
    }
    const isNewDataset = workspace.datasetVersion !== renderedDatasetVersionRef.current
    renderChartData(chart, visibleChartData, { fitToContent: isNewDataset, isRelativeScale })
    renderedDatasetVersionRef.current = workspace.datasetVersion
  }, [visibleChartData, workspace.datasetVersion, isRelativeScale])

  // Tell the drawer's Insights tab what is on the chart and where it came from.
  const { setChartInsights } = useChartInsights()
  const insightSymbol = isShowingMarketPrices && marketInstrument
    ? displaySymbol(marketInstrument.symbol)
    : isScreenSource ? screenChart.symbol : null
  const insightLastPrice = isPairSource && isShowingMarketPrices
    ? formatMarketPrice(marketChart.meta?.lastPrice)
    : isScreenSource ? screenChart.titleLastPrice : null
  useEffect(() => {
    setChartInsights({
      summary: visibleChartData?.summary ?? null,
      dataOrigin: visibleChartData ? workspace.dataOrigin : null,
      sourceName: workspace.sourceName,
      computedAt: workspace.computedAt,
      candleCount: visibleChartData?.candles.length ?? 0,
      symbol: insightSymbol,
      symbolSource: isPairSource ? 'pair' : isScreenSource && screenChart.symbol ? 'window_title' : null,
      assetKind: isShowingMarketPrices ? (marketChart.meta?.kind ?? marketInstrument?.kind ?? null) : null,
      instrumentName: isShowingMarketPrices ? (marketChart.meta?.name ?? marketInstrument?.name ?? null) : null,
      titleLastPrice: insightLastPrice,
      titleChange: isScreenSource ? screenChart.titleChange : null,
      titleDirection: isScreenSource ? screenChart.titleDirection : null,
    })
  }, [
    setChartInsights,
    visibleChartData,
    workspace.dataOrigin,
    workspace.sourceName,
    workspace.computedAt,
    insightSymbol,
    insightLastPrice,
    isPairSource,
    isScreenSource,
    isShowingMarketPrices,
    marketChart.meta,
    marketInstrument,
    screenChart.symbol,
    screenChart.titleChange,
    screenChart.titleDirection,
  ])

  const legendEntries = useMemo(() => buildLegendEntries(visibleChartData), [visibleChartData])
  const openFilePicker = () => fileInputRef.current?.click()
  const handleFileChosen = (changeEvent) => {
    const chosenFile = changeEvent.target.files?.[0]
    changeEvent.target.value = '' // allow re-opening the same file
    if (!chosenFile) return
    setChartSource('file')
    workspace.loadCandleFile(chosenFile)
  }
  const changeChartSource = (nextSource) => {
    lastFedDatasetKeyRef.current = null // refit when coming back to a source
    setChartSource(nextSource)
  }
  const selectPair = (pair) => {
    setSelectedPair({ symbol: pair.symbol, name: pair.name, kind: pair.kind, exchange: pair.exchange ?? null })
    setChartSource('pair')
  }

  const hasChartData = visibleChartData !== null
  const isBusy = workspace.status === 'parsing' || workspace.status === 'computing'
  const isStale = hasChartData && !isConnected
  const summary = visibleChartData?.summary
  const fileNotice = workspace.fileNotice
  const canRetryFailure = workspace.status === 'failed' && workspace.canRetry && workspace.error?.isRecoverable
  const showFileFailure = chartSource === 'file' && workspace.status === 'failed'
  const isScreenChartAway =
    isScreenSource && hasChartData && (!screenChart.isInView || !chartWatch.isChartInView)
  const showTimeframes = (isPairSource && selectedPair !== null) || (isScreenSource && isShowingMarketPrices)
  const titleInstrument = isPairSource ? selectedPair : isShowingMarketPrices ? marketInstrument : null

  let chartTitle = 'CSV file'
  if (titleInstrument) chartTitle = titleInstrument.symbol
  else if (isScreenSource) chartTitle = 'Your screen'
  else if (isPairSource) chartTitle = 'Pair'
  else if (workspace.dataOrigin === 'file' && workspace.sourceName) chartTitle = workspace.sourceName

  let chartSubtitle = null
  if (hasChartData && isShowingMarketPrices) {
    const lastPriceText = formatMarketPrice(marketChart.meta?.lastPrice)
    chartSubtitle = [
      marketChart.meta?.name ?? titleInstrument?.name,
      isScreenSource ? 'on your screen' : null,
      lastPriceText ? `${lastPriceText}${marketChart.meta?.currency ? ` ${marketChart.meta.currency}` : ''}` : null,
    ]
      .filter(Boolean)
      .join(' · ')
  } else if (hasChartData && isRelativeScale) {
    chartSubtitle = `${visibleChartData.candles.length.toLocaleString()} candles · relative scale`
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Wraps onto a second row in a narrow window instead of overlapping. */}
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-divider px-3 py-1.5 md:gap-x-4 md:px-4">
        <div className="flex min-w-[4.5rem] flex-1 items-center gap-2">
          {titleInstrument && <AssetKindIcon kind={marketChart.meta?.kind ?? titleInstrument.kind} size={14} />}
          <h1
            className="max-w-[14rem] min-w-[3.5rem] truncate font-serif text-[17px] leading-none font-semibold text-bone"
            title={chartTitle}
          >
            {chartTitle}
          </h1>
          {(chartSubtitle || (hasChartData && fileNotice && chartSource === 'file')) && (
            <span className="hidden truncate text-[11px] text-muted tabular-figures sm:inline">
              {chartSource === 'file' && fileNotice ? (
                <>
                  {fileNotice.candleCount.toLocaleString()} bars
                  {fileNotice.truncatedRowCount > 0 &&
                    ` · most recent ${MAX_CANDLES_PER_REQUEST.toLocaleString()} (service limit)`}
                  {fileNotice.skippedRowCount > 0 && ` · ${fileNotice.skippedRowCount} unreadable rows skipped`}
                </>
              ) : (
                chartSubtitle
              )}
            </span>
          )}
        </div>

        {legendEntries.length > 0 && (
          <ul aria-label="Plotted indicator series" className="hidden min-w-0 items-center gap-3 overflow-hidden xl:flex">
            {legendEntries.map((legendEntry) => (
              <li key={legendEntry.key} className="flex items-center gap-1.5 text-[11px] whitespace-nowrap text-muted">
                <span aria-hidden="true" className="h-px w-3" style={{ backgroundColor: legendEntry.color, height: 2 }} />
                {legendEntry.key}
              </li>
            ))}
          </ul>
        )}

        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-2 md:gap-3">
          <SignalPanel summary={summary} dataOrigin={workspace.dataOrigin} />
          {isBusy && hasChartData && chartSource === 'file' && (
            <span className="hidden items-center gap-1.5 text-[11px] text-muted sm:flex" role="status">
              <LoaderCircle size={12} aria-hidden="true" className="motion-safe:animate-spin" /> Computing…
            </span>
          )}
          {isStale && (
            <span className="hidden text-[11px] font-medium text-caution md:inline" role="status">
              Engine offline · series from {formatClockTime(workspace.computedAt)}
            </span>
          )}
          <SegmentedControl
            label="Source"
            labelPlacement="inline"
            options={CHART_SOURCES}
            value={chartSource}
            onChange={changeChartSource}
            className="[&>span]:hidden md:[&>span]:inline"
          />
          {isPairSource && (
            <PairSearch selectedPair={selectedPair} onSelect={selectPair} onClear={() => setSelectedPair(null)} />
          )}
          {chartSource === 'file' && hasChartData && <OpenFileButton onClick={openFilePicker} variant="secondary" compact />}
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

      {showFileFailure && hasChartData && (
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
        <div
          ref={chartContainerRef}
          className={cn(
            'absolute inset-0 transition-[opacity,filter] duration-300',
            isScreenChartAway && isRelativeScale && 'opacity-40 grayscale',
          )}
          data-testid="chart-container"
        />

        {(showTimeframes || isScreenChartAway) && (
          // Top-left, clear of the price axis; wraps onto two rows in a narrow window.
          <div className="pointer-events-none absolute top-2 right-20 left-2 z-20 flex flex-wrap items-center gap-2 [&>*]:pointer-events-auto">
            {showTimeframes && <TimeframeBar value={timeframe} onChange={setTimeframe} />}
            {isScreenChartAway && (
              <div
                role="status"
                className="flex items-center gap-1.5 rounded-full border border-divider bg-obsidian/90 px-3 py-1 text-[11px] text-bone backdrop-blur-sm"
              >
                <EyeOff size={12} aria-hidden="true" className="shrink-0 text-muted" />
                {isRelativeScale
                  ? 'Chart not in view · showing the last reading'
                  : 'Chart window not in view · prices still live'}
              </div>
            )}
          </div>
        )}

        {isScreenSource && !hasChartData && <ScreenSourceState chartWatch={chartWatch} screenChart={screenChart} />}

        {isPairSource && !hasChartData && (
          <PairSourceState selectedPair={selectedPair} marketChart={marketChart} isComputing={isBusy} />
        )}

        {chartSource === 'file' && !hasChartData && !isBusy && !showFileFailure && (
          <ChartStatePanel title="Load real prices from a file">
            <p className="text-[13px] leading-relaxed text-muted">
              Open a CSV export from your broker and the engine will compute the indicators on your
              actual prices.
            </p>
            <p className="text-[11px] text-muted">
              Columns: <span className="text-bone/80">time, open, high, low, close</span> (volume optional).
              Daily dates (YYYY-MM-DD) or timestamps.
            </p>
            <OpenFileButton onClick={openFilePicker} />
          </ChartStatePanel>
        )}

        {isBusy && !hasChartData && chartSource === 'file' && (
          <ChartStatePanel
            icon={<LoaderCircle size={22} aria-hidden="true" className="text-accent motion-safe:animate-spin" />}
            title={workspace.status === 'parsing' ? 'Reading file…' : 'Computing indicators…'}
          >
            <p className="text-[12px] text-muted" role="status">
              {workspace.sourceName}
            </p>
          </ChartStatePanel>
        )}

        {showFileFailure && !hasChartData && (
          <ChartStatePanel
            icon={<AlertTriangle size={22} aria-hidden="true" className="text-loss" />}
            title="Couldn’t load the chart"
          >
            <p role="alert" className="text-[13px] leading-relaxed text-muted">
              {describeWorkspaceError(workspace.error)}
            </p>
            {workspace.error?.code === 'engine_unreachable' && <EngineStartHint />}
            <div className="flex items-center gap-2">
              {canRetryFailure && (
                <button
                  type="button"
                  onClick={workspace.retry}
                  className="inline-flex items-center gap-2 rounded-full bg-accent px-3.5 py-1.5 text-[12px] font-semibold text-obsidian shadow-[0_2px_10px_rgba(106,134,176,0.35)] hover:bg-accent-strong"
                >
                  <RotateCcw size={13} aria-hidden="true" /> Retry
                </button>
              )}
              <OpenFileButton onClick={openFilePicker} variant={canRetryFailure ? 'secondary' : 'primary'} />
            </div>
          </ChartStatePanel>
        )}
      </div>

      <ChartSourceLine
        visibleChartData={visibleChartData}
        dataOrigin={workspace.dataOrigin}
        sourceName={workspace.sourceName}
        computedAt={workspace.computedAt}
        screenChart={screenChart}
        marketChart={marketChart}
        isScreenSource={isScreenSource}
        timeframe={timeframe}
      />
    </div>
  )
}

/** The MT mark with one line of status, for a source that has nothing to draw. */
function LogoState({ statusLine, children }) {
  return (
    <div className="absolute inset-0 z-10 grid place-items-center bg-obsidian" role="status">
      <div className="flex flex-col items-center gap-4">
        <img src={maisonLogo} alt="Maison Terminal" className="size-20 rounded-2xl ring-1 ring-divider" draggable={false} />
        <p className="font-serif text-[20px] text-bone">{statusLine}</p>
        {children}
      </div>
    </div>
  )
}

/** Screen source with nothing to draw: just the MT mark and one line of status. */
function ScreenSourceState({ chartWatch, screenChart }) {
  const isOff = !chartWatch.isAutoWatchEnabled && !chartWatch.isWatching
  let statusLine = 'No chart detected'
  if (isOff) statusLine = 'Chart watch is off'
  else if (chartWatch.isWatching && !chartWatch.isChartInView) statusLine = 'Chart not in view'
  else if (chartWatch.isWatching && chartWatch.visionState !== 'no_chart') {
    statusLine = screenChart.status === 'unreadable' ? 'Chart detected · candles can’t be read' : 'Reading chart…'
  }
  return (
    <LogoState statusLine={statusLine}>
      {isOff && (
        <button type="button" onClick={chartWatch.startWatching} className={PRIMARY_PILL_CLASS}>
          <ScanEye size={13} aria-hidden="true" /> Turn on chart watch
        </button>
      )}
    </LogoState>
  )
}

/** Pair source with nothing to draw yet: no pair chosen, loading, or the provider failed. */
function PairSourceState({ selectedPair, marketChart, isComputing }) {
  if (!selectedPair) {
    return (
      <LogoState statusLine="No pair selected">
        <p className="text-[12px] text-muted">Search for a stock, ETF, index, forex pair or crypto above.</p>
      </LogoState>
    )
  }
  if (marketChart.status === 'error') {
    const reason =
      marketChart.error?.code === 'unknown_symbol' || marketChart.error?.code === 'no_price_history'
        ? `No price history is available for ${selectedPair.symbol} at this timeframe.`
        : (marketChart.error?.message ?? 'The price data provider could not be reached.')
    return (
      <ChartStatePanel icon={<AlertTriangle size={22} aria-hidden="true" className="text-loss" />} title="Couldn’t load prices">
        <p role="alert" className="text-[13px] leading-relaxed text-muted">
          {reason}
        </p>
      </ChartStatePanel>
    )
  }
  return (
    <ChartStatePanel
      icon={<LoaderCircle size={22} aria-hidden="true" className="text-accent motion-safe:animate-spin" />}
      title={isComputing ? 'Computing indicators…' : `Loading ${selectedPair.symbol}…`}
    >
      <p className="text-[12px] text-muted" role="status">
        {selectedPair.name}
      </p>
    </ChartStatePanel>
  )
}

/** One line under the chart saying exactly where the plotted data came from. */
function ChartSourceLine({ visibleChartData, dataOrigin, sourceName, computedAt, screenChart, marketChart, isScreenSource, timeframe }) {
  if (!visibleChartData) return null
  let sourceText
  if (dataOrigin === 'market') {
    const symbolOrigin = isScreenSource && screenChart.symbol ? `${screenChart.symbol} recognised from your chart window title; ` : ''
    sourceText = `Source: ${symbolOrigin}${marketChart.meta?.symbol ?? sourceName} prices from ${marketChart.meta?.source ?? 'Yahoo Finance'}, ${timeframeLabel(timeframe)} bars, refreshed ${formatClockTime(marketChart.fetchedAt)}.`
  } else if (dataOrigin === 'screen') {
    const region = screenChart.region
    const regionText = region ? ` (${region.width}×${region.height} px at ${region.left}, ${region.top})` : ''
    const readingNote = screenChart.note ? ` ${screenChart.note}` : ''
    sourceText = `Source: candles read from your screen${regionText} at ${formatClockTime(screenChart.capturedAt)}. Relative scale: 0 = bottom of your chart, 100 = top, not prices.${readingNote}`
  } else {
    sourceText = `Source: prices from ${sourceName ?? 'your CSV file'}.`
  }
  return (
    <p
      className="flex shrink-0 items-center gap-1.5 truncate border-t border-divider px-4 py-1.5 text-[11px] text-muted"
      title={sourceText}
      data-selectable
    >
      <Info size={11} aria-hidden="true" className="shrink-0" />
      <span className="truncate">
        {sourceText} Indicators computed by the Maison engine (pandas-ta) at {formatClockTime(computedAt)}.
      </span>
    </p>
  )
}
