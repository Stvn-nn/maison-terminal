/**
 * Client-boundary handling of price data the user loads from a broker CSV export.
 *
 * The analytical service exposes no price-history endpoint, so candles come only from a
 * file the user chooses. This module parses and normalises them into the forms the
 * service and Lightweight Charts both accept:
 *   - daily rows  -> business-day strings "YYYY-MM-DD"
 *   - intraday    -> UTC unix timestamps in seconds
 * Rows are sorted ascending and deduplicated by time (last row for a time wins).
 */

const BUSINESS_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MILLISECOND_EPOCH_THRESHOLD = 1e11 // larger values are milliseconds, not seconds

const COLUMN_ALIASES = {
  time: ['time', 'date', 'datetime', 'timestamp', 'date/time', 'gmt time', 'local time'],
  open: ['open', 'o'],
  high: ['high', 'h'],
  low: ['low', 'l'],
  close: ['close', 'c', 'last', 'adj close'],
  volume: ['volume', 'vol', 'v', 'tick volume'],
}

export class CandleFileError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CandleFileError'
  }
}

/** Compare two chart times of the same kind (number seconds or "YYYY-MM-DD"). */
export function compareChartTimes(firstTime, secondTime) {
  if (typeof firstTime === 'number' && typeof secondTime === 'number') {
    return firstTime - secondTime
  }
  return String(firstTime).localeCompare(String(secondTime))
}

export function sortAndDeduplicateByTime(points) {
  const pointsByTime = new Map()
  for (const point of points) {
    if (point && point.time !== undefined && point.time !== null) {
      pointsByTime.set(point.time, point) // later duplicates replace earlier ones
    }
  }
  return [...pointsByTime.values()].sort((firstPoint, secondPoint) =>
    compareChartTimes(firstPoint.time, secondPoint.time),
  )
}

/** Line/histogram points: keep finite values only (warm-up gaps are never plotted as 0). */
export function normalizeSeriesPoints(points) {
  return sortAndDeduplicateByTime(
    points.filter((point) => typeof point?.value === 'number' && Number.isFinite(point.value)),
  )
}

function splitCsvLine(line, delimiter) {
  const fields = []
  let currentField = ''
  let insideQuotes = false
  for (let characterIndex = 0; characterIndex < line.length; characterIndex += 1) {
    const character = line[characterIndex]
    if (character === '"') {
      if (insideQuotes && line[characterIndex + 1] === '"') {
        currentField += '"'
        characterIndex += 1
      } else {
        insideQuotes = !insideQuotes
      }
    } else if (character === delimiter && !insideQuotes) {
      fields.push(currentField)
      currentField = ''
    } else {
      currentField += character
    }
  }
  fields.push(currentField)
  return fields.map((field) => field.trim())
}

function detectDelimiter(headerLine) {
  const candidateDelimiters = [',', ';', '\t']
  return candidateDelimiters.reduce((bestDelimiter, candidate) =>
    headerLine.split(candidate).length > headerLine.split(bestDelimiter).length
      ? candidate
      : bestDelimiter,
  )
}

function resolveColumnIndexes(headerFields) {
  const BYTE_ORDER_MARK = String.fromCharCode(0xfeff) // Excel adds it to UTF-8 CSV exports
  const normalizedHeaders = headerFields.map((header) =>
    header.toLowerCase().replace(BYTE_ORDER_MARK, '').trim(),
  )
  const columnIndexes = {}
  for (const [canonicalName, aliases] of Object.entries(COLUMN_ALIASES)) {
    const matchedIndex = normalizedHeaders.findIndex((header) => aliases.includes(header))
    if (matchedIndex !== -1) columnIndexes[canonicalName] = matchedIndex
  }
  const missingColumns = ['time', 'open', 'high', 'low', 'close'].filter(
    (requiredColumn) => columnIndexes[requiredColumn] === undefined,
  )
  if (missingColumns.length > 0) {
    throw new CandleFileError(
      `The file is missing required column(s): ${missingColumns.join(', ')}. ` +
        'Expected a header row such as "time,open,high,low,close,volume".',
    )
  }
  return columnIndexes
}

function parseNumber(rawValue) {
  if (rawValue === undefined || rawValue === '') return null
  const parsedValue = Number(rawValue.replace(/[\s_]/g, ''))
  return Number.isFinite(parsedValue) ? parsedValue : null
}

/**
 * Convert one raw time cell to a chart time.
 * Naive date-times (no offset) are read as UTC so chart labels match the file's text.
 */
export function normalizeChartTime(rawTime) {
  const trimmedTime = String(rawTime).trim()
  if (BUSINESS_DAY_PATTERN.test(trimmedTime)) return trimmedTime
  if (/^\d+(\.\d+)?$/.test(trimmedTime)) {
    const epochValue = Number(trimmedTime)
    const epochSeconds = epochValue > MILLISECOND_EPOCH_THRESHOLD ? epochValue / 1000 : epochValue
    return Math.floor(epochSeconds)
  }
  const hasExplicitOffset = /([zZ]|[+-]\d{2}:?\d{2})$/.test(trimmedTime)
  const isoLikeTime = trimmedTime.replace(' ', 'T')
  const parsedMilliseconds = Date.parse(hasExplicitOffset ? isoLikeTime : `${isoLikeTime}Z`)
  if (Number.isNaN(parsedMilliseconds)) return null
  return Math.floor(parsedMilliseconds / 1000)
}

/**
 * Parse CSV text into candles ready for the service.
 * @returns {{candles: Array, skippedRowCount: number, truncatedRowCount: number}}
 */
export function parseCandleCsv(csvText, { maxCandles = Infinity } = {}) {
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length < 3) {
    throw new CandleFileError('The file needs a header row and at least two price rows.')
  }
  const delimiter = detectDelimiter(lines[0])
  const columnIndexes = resolveColumnIndexes(splitCsvLine(lines[0], delimiter))

  const parsedCandles = []
  let skippedRowCount = 0
  for (const line of lines.slice(1)) {
    const fields = splitCsvLine(line, delimiter)
    const chartTime = normalizeChartTime(fields[columnIndexes.time] ?? '')
    const openPrice = parseNumber(fields[columnIndexes.open])
    const highPrice = parseNumber(fields[columnIndexes.high])
    const lowPrice = parseNumber(fields[columnIndexes.low])
    const closePrice = parseNumber(fields[columnIndexes.close])
    if (chartTime === null || [openPrice, highPrice, lowPrice, closePrice].includes(null)) {
      skippedRowCount += 1
      continue
    }
    const candle = { time: chartTime, open: openPrice, high: highPrice, low: lowPrice, close: closePrice }
    if (columnIndexes.volume !== undefined) {
      const volumeValue = parseNumber(fields[columnIndexes.volume])
      if (volumeValue !== null && volumeValue >= 0) candle.volume = volumeValue
    }
    parsedCandles.push(candle)
  }

  const timeKinds = new Set(parsedCandles.map((candle) => typeof candle.time))
  if (timeKinds.size > 1) {
    throw new CandleFileError('The file mixes daily dates and intraday timestamps.')
  }
  const orderedCandles = sortAndDeduplicateByTime(parsedCandles)
  if (orderedCandles.length < 2) {
    throw new CandleFileError('Fewer than two valid price rows were found in the file.')
  }
  const truncatedRowCount = Math.max(0, orderedCandles.length - maxCandles)
  return {
    candles: truncatedRowCount > 0 ? orderedCandles.slice(-maxCandles) : orderedCandles,
    skippedRowCount,
    truncatedRowCount,
  }
}
