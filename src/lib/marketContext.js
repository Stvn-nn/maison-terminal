/**
 * Which economies move an instrument, so upcoming releases can be filtered to the ones that
 * matter for the chart being watched (e.g. EURUSD -> euro area + US, SPX -> US).
 */

const CURRENCY_COUNTRIES = {
  USD: 'US', EUR: 'EU', GBP: 'GB', JPY: 'JP', CHF: 'CH', CAD: 'CA', AUD: 'AU', NZD: 'NZ',
  CNY: 'CN', CNH: 'CN', HKD: 'HK', SEK: 'SE', NOK: 'NO', MXN: 'MX', ZAR: 'ZA', SGD: 'SG',
}
const CRYPTO_BASES = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'LTC', 'BNB', 'AVAX', 'DOT']
const US_INSTRUMENTS = /^(SPX|GSPC|SPY|ES1?!?|MES1?!?|NDX|IXIC|NQ1?!?|QQQ|DJI|DIA|YM1?!?|RUT|IWM|VIX|DXY|US\d{2,3})$/
const ASSET_KIND_DESCRIPTIONS = { stock: 'Stock', etf: 'ETF', index: 'Index', future: 'Futures', fund: 'Fund' }

/**
 * @param {string|null} symbol  As shown on a chart ("EURUSD") or by the price provider ("EURUSD=X", "^GSPC").
 * @param {string|null} [assetKind]  Asset type from the symbol search, when known.
 * @returns {{symbol: string|null, kind: 'forex'|'crypto'|'us_index'|'other'|'unknown',
 *            countries: string[], description: string}}
 */
export function describeInstrument(symbol, assetKind = null) {
  if (!symbol) return { symbol: null, kind: 'unknown', countries: [], description: 'Symbol not detected' }
  const normalized = symbol.toUpperCase().replace(/=X$/, '').replace(/^\^/, '').replace(/[/_-]/g, '')

  const baseCurrency = normalized.slice(0, 3)
  const quoteCurrency = normalized.slice(3, 6)
  if (normalized.length === 6 && CURRENCY_COUNTRIES[baseCurrency] && CURRENCY_COUNTRIES[quoteCurrency]) {
    return {
      symbol,
      kind: 'forex',
      countries: [CURRENCY_COUNTRIES[baseCurrency], CURRENCY_COUNTRIES[quoteCurrency]],
      description: `Currency pair · ${baseCurrency} / ${quoteCurrency}`,
    }
  }
  const cryptoBase = CRYPTO_BASES.find((base) => normalized.startsWith(base))
  if (cryptoBase) {
    const quote = normalized.slice(cryptoBase.length).replace(/^USD[TC]?$/, 'USD')
    return {
      symbol,
      kind: 'crypto',
      countries: CURRENCY_COUNTRIES[quote] ? [CURRENCY_COUNTRIES[quote]] : [],
      description: `Crypto · ${cryptoBase}${quote ? ` / ${quote}` : ''}`,
    }
  }
  if (US_INSTRUMENTS.test(normalized)) {
    return { symbol, kind: 'us_index', countries: ['US'], description: 'US index / ETF' }
  }
  return { symbol, kind: 'other', countries: [], description: ASSET_KIND_DESCRIPTIONS[assetKind] ?? 'Instrument' }
}

/** Releases in the next `horizonMs`, limited to the instrument's economies when known. */
export function relevantReleases(events, instrument, currentTime, horizonMs = 24 * 60 * 60 * 1000) {
  return events.filter((event) => {
    const millisecondsUntil = event.releaseTime.getTime() - currentTime
    const isUpcoming = millisecondsUntil >= 0 && millisecondsUntil <= horizonMs
    const isRelevant = instrument.countries.length === 0 || instrument.countries.includes(event.country)
    return isUpcoming && isRelevant
  })
}
