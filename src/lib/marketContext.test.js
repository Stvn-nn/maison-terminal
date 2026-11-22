import { describe, expect, it } from 'vitest'

import { describeInstrument, relevantReleases } from './marketContext.js'

describe('describeInstrument', () => {
  it.each([
    ['EURUSD', 'forex', ['EU', 'US']],
    ['GBP/JPY', 'forex', ['GB', 'JP']],
    ['BTCUSDT', 'crypto', ['US']],
    ['SPX', 'us_index', ['US']],
    ['ES1!', 'us_index', ['US']],
    ['TSLA', 'other', []],
    [null, 'unknown', []],
  ])('maps %s to %s affected by %j', (symbol, expectedKind, expectedCountries) => {
    const instrument = describeInstrument(symbol)
    expect(instrument.kind).toBe(expectedKind)
    expect(instrument.countries).toEqual(expectedCountries)
  })
})

describe('relevantReleases', () => {
  // TEST FIXTURE ONLY: calendar events in the normalised client shape.
  const currentTime = Date.UTC(2026, 10, 21, 12, 0)
  const event = (id, country, hoursFromNow) => ({
    id,
    country,
    releaseTime: new Date(currentTime + hoursFromNow * 3_600_000),
  })
  const events = [event('us-soon', 'US', 2), event('eu-soon', 'EU', 3), event('us-past', 'US', -1), event('us-later', 'US', 30)]

  it('keeps upcoming releases in the next 24 hours for the instrument economies', () => {
    const releases = relevantReleases(events, describeInstrument('SPX'), currentTime)
    expect(releases.map((release) => release.id)).toEqual(['us-soon'])
  })

  it('keeps every economy when the instrument is unknown', () => {
    const releases = relevantReleases(events, describeInstrument(null), currentTime)
    expect(releases.map((release) => release.id)).toEqual(['us-soon', 'eu-soon'])
  })
})
