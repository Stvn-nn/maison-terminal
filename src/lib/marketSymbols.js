import {
  ArrowLeftRight,
  BarChart3,
  Bitcoin,
  Building2,
  CircleDot,
  Hourglass,
  Layers,
  PieChart,
} from 'lucide-react'

/** How each asset type from the market-data search is labelled and drawn next to its ticker. */
export const ASSET_KINDS = {
  stock: { label: 'Stock', Icon: Building2, colorClass: 'text-accent-strong' },
  etf: { label: 'ETF', Icon: Layers, colorClass: 'text-[#7FA7A0]' },
  index: { label: 'Index', Icon: BarChart3, colorClass: 'text-[#B8A07E]' },
  forex: { label: 'Forex', Icon: ArrowLeftRight, colorClass: 'text-gain' },
  crypto: { label: 'Crypto', Icon: Bitcoin, colorClass: 'text-caution' },
  future: { label: 'Futures', Icon: Hourglass, colorClass: 'text-[#A88FB8]' },
  fund: { label: 'Fund', Icon: PieChart, colorClass: 'text-[#C9C9CF]' },
  other: { label: 'Other', Icon: CircleDot, colorClass: 'text-muted' },
}

export function assetKindInfo(kind) {
  return ASSET_KINDS[kind] ?? ASSET_KINDS.other
}

/** Timeframes offered for real price charts, in display order (values match the engine). */
export const TIMEFRAMES = [
  { value: '1m', label: '1m', description: '1-minute bars (about the last 5 days)' },
  { value: '5m', label: '5m', description: '5-minute bars (about the last month)' },
  { value: '15m', label: '15m', description: '15-minute bars (about the last month)' },
  { value: '30m', label: '30m', description: '30-minute bars (about the last month)' },
  { value: '1h', label: '1H', description: 'Hourly bars (about the last 6 months)' },
  { value: '1d', label: 'D', description: 'Daily bars (about the last 2 years)' },
  { value: '1w', label: 'W', description: 'Weekly bars (about the last 10 years)' },
  { value: '1M', label: 'M', description: 'Monthly bars (full history)' },
]
export const DEFAULT_TIMEFRAME = '5m'

/** How often to refresh a live chart: intraday bars change quickly, monthly ones barely. */
export function refreshIntervalMs(timeframe) {
  if (timeframe === '1m') return 15_000
  if (['5m', '15m', '30m'].includes(timeframe)) return 30_000
  if (timeframe === '1h') return 60_000
  return 120_000
}

/** Letters and digits only, so "EUR/USD", "EURUSD=X" and "BTC-USD" compare cleanly. */
function comparableSymbol(symbol) {
  return String(symbol ?? '')
    .toUpperCase()
    .replace(/=X$/, '')
    .replace(/[^A-Z0-9]/g, '')
}

/**
 * Pick the market-data symbol for a ticker read off a chart window title
 * (TradingView "SPX" -> "^SPX", "EURUSD" -> "EURUSD=X", "BTCUSD" -> "BTC-USD").
 * Prefers an exact match ignoring punctuation; otherwise the provider's top result.
 */
export function bestSymbolMatch(screenSymbol, matches) {
  if (!screenSymbol || !matches || matches.length === 0) return null
  const wanted = comparableSymbol(screenSymbol.replace(/\d*!$/, '')) // "ES1!" continuous futures
  return matches.find((match) => comparableSymbol(match.symbol) === wanted) ?? matches[0]
}

/** Short ticker for display and news lookups: "EURUSD=X" -> "EURUSD", "^GSPC" -> "GSPC". */
export function displaySymbol(symbol) {
  return String(symbol ?? '')
    .replace(/=X$/, '')
    .replace(/^\^/, '')
}
