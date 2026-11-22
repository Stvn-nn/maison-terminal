import { createContext, useContext } from 'react'

/**
 * What the chart is currently showing, published by ChartCanvas and read by the drawer's
 * Insights tab: the engine's strategy summary, where the data came from, and the symbol
 * (read from the chart window's title, or the pair the user chose).
 */
export const EMPTY_CHART_INSIGHTS = Object.freeze({
  summary: null,
  dataOrigin: null, // 'screen' | 'market' | 'file' | null
  sourceName: null,
  computedAt: null,
  candleCount: 0,
  symbol: null,
  symbolSource: null, // 'window_title' | 'pair' | null
  assetKind: null, // 'stock' | 'etf' | 'index' | 'forex' | 'crypto' | 'future' | 'fund' | 'other' | null
  instrumentName: null,
  titleLastPrice: null,
  titleChange: null,
  titleDirection: null,
})

export const ChartInsightsContext = createContext(null)

export function useChartInsights() {
  const chartInsightsState = useContext(ChartInsightsContext)
  if (chartInsightsState === null) throw new Error('useChartInsights must be used inside ChartInsightsProvider')
  return chartInsightsState
}
