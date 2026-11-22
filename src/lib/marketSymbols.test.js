import { describe, expect, it } from 'vitest'

import { describeInstrument } from './marketContext.js'
import { TIMEFRAMES, assetKindInfo, bestSymbolMatch, displaySymbol, refreshIntervalMs } from './marketSymbols.js'

// TEST FIXTURE ONLY: suggestion rows in the engine's /api/v1/market/search shape.
const match = (symbol, kind) => ({ symbol, name: symbol, kind, exchange: null })

describe('bestSymbolMatch', () => {
  it('maps chart tickers to the provider symbol ignoring punctuation', () => {
    expect(bestSymbolMatch('EURUSD', [match('M6E=F', 'future'), match('EURUSD=X', 'forex')]).symbol).toBe('EURUSD=X')
    expect(bestSymbolMatch('BTCUSD', [match('BTC=F', 'future'), match('BTC-USD', 'crypto')]).symbol).toBe('BTC-USD')
    expect(bestSymbolMatch('SPX', [match('^SPX', 'index'), match('SPXL', 'etf')]).symbol).toBe('^SPX')
  })

  it('falls back to the top result and handles empty input', () => {
    expect(bestSymbolMatch('ES1!', [match('ES=F', 'future')]).symbol).toBe('ES=F')
    expect(bestSymbolMatch('AAPL', [])).toBeNull()
    expect(bestSymbolMatch(null, [match('AAPL', 'stock')])).toBeNull()
  })
})

describe('symbol helpers', () => {
  it('shortens provider symbols for display', () => {
    expect(displaySymbol('EURUSD=X')).toBe('EURUSD')
    expect(displaySymbol('^GSPC')).toBe('GSPC')
    expect(displaySymbol('AAPL')).toBe('AAPL')
  })

  it('offers the eight requested timeframes in order', () => {
    expect(TIMEFRAMES.map((timeframe) => timeframe.value)).toEqual(['1m', '5m', '15m', '30m', '1h', '1d', '1w', '1M'])
  })

  it('refreshes fast timeframes more often', () => {
    expect(refreshIntervalMs('1m')).toBeLessThan(refreshIntervalMs('1h'))
    expect(refreshIntervalMs('1h')).toBeLessThan(refreshIntervalMs('1M'))
  })

  it('labels every asset type and falls back for unknown ones', () => {
    expect(assetKindInfo('crypto').label).toBe('Crypto')
    expect(assetKindInfo('mystery').label).toBe('Other')
  })

  it('describes provider spellings of instruments', () => {
    expect(describeInstrument('EURUSD=X').countries).toEqual(['EU', 'US'])
    expect(describeInstrument('^GSPC').kind).toBe('us_index')
    expect(describeInstrument('AAPL', 'stock').description).toBe('Stock')
  })
})
