import { describe, expect, it } from 'vitest'

import { CandleFileError, normalizeChartTime, normalizeSeriesPoints, parseCandleCsv } from './candles.js'

// TEST FIXTURES ONLY: synthetic CSV text exercising parser edge cases (not market data).
const DAILY_CSV = `Date,Open,High,Low,Close,Volume
2026-01-06,11,12,10,11.5,900
2026-01-05,10,11,9,10.5,1000
2026-01-06,11,12.5,10,12,950
`

describe('normalizeChartTime', () => {
  it('keeps business days as strings for daily data', () => {
    expect(normalizeChartTime('2026-01-05')).toBe('2026-01-05')
  })

  it('accepts unix seconds and converts milliseconds', () => {
    expect(normalizeChartTime('1767225600')).toBe(1767225600)
    expect(normalizeChartTime('1767225600000')).toBe(1767225600)
  })

  it('honours explicit offsets and reads naive date-times as UTC', () => {
    expect(normalizeChartTime('2026-01-01T09:30:00-05:00')).toBe(Date.UTC(2026, 0, 1, 14, 30) / 1000)
    expect(normalizeChartTime('2026-01-01 14:30:00')).toBe(Date.UTC(2026, 0, 1, 14, 30) / 1000)
  })

  it('returns null for unreadable times', () => {
    expect(normalizeChartTime('yesterday-ish')).toBeNull()
  })
})

describe('parseCandleCsv', () => {
  it('sorts ascending and lets the last duplicate row win', () => {
    const { candles } = parseCandleCsv(DAILY_CSV)
    expect(candles.map((candle) => candle.time)).toEqual(['2026-01-05', '2026-01-06'])
    expect(candles[1]).toEqual({ time: '2026-01-06', open: 11, high: 12.5, low: 10, close: 12, volume: 950 })
  })

  it('handles BOM headers, semicolons and missing volume', () => {
    const csvText = '﻿time;open;high;low;close\n1767225600;1;2;0.5;1.5\n1767229200;1.5;2;1;1.8\n'
    const { candles } = parseCandleCsv(csvText)
    expect(candles).toHaveLength(2)
    expect(candles[0]).not.toHaveProperty('volume')
  })

  it('skips unreadable rows and reports them', () => {
    const csvText = 'time,open,high,low,close\n2026-01-05,1,2,0.5,1.5\nbad,row,,,\n2026-01-06,1.5,2,1,1.8\n'
    const parsedFile = parseCandleCsv(csvText)
    expect(parsedFile.candles).toHaveLength(2)
    expect(parsedFile.skippedRowCount).toBe(1)
  })

  it('keeps only the most recent rows beyond the service limit', () => {
    const parsedFile = parseCandleCsv(DAILY_CSV, { maxCandles: 1 })
    expect(parsedFile.candles.map((candle) => candle.time)).toEqual(['2026-01-06'])
    expect(parsedFile.truncatedRowCount).toBe(1)
  })

  it.each([
    ['missing columns', 'time,open,close\n2026-01-05,1,2\n2026-01-06,1,2\n', /missing required column/],
    ['too few rows', 'time,open,high,low,close\n2026-01-05,1,2,0.5,1\n', /header row and at least two/],
    [
      'mixed time formats',
      'time,open,high,low,close\n2026-01-05,1,2,0.5,1\n1767225600,1,2,0.5,1\n',
      /mixes daily dates and intraday/,
    ],
  ])('rejects %s', (_label, csvText, expectedMessage) => {
    expect(() => parseCandleCsv(csvText)).toThrow(CandleFileError)
    expect(() => parseCandleCsv(csvText)).toThrow(expectedMessage)
  })
})

describe('normalizeSeriesPoints', () => {
  it('drops warm-up gaps instead of plotting zeros, and orders by time', () => {
    const points = normalizeSeriesPoints([
      { time: 3, value: 30 },
      { time: 1, value: null },
      { time: 2, value: Number.NaN },
      { time: 0, value: 0 },
    ])
    expect(points).toEqual([
      { time: 0, value: 0 },
      { time: 3, value: 30 },
    ])
  })
})
