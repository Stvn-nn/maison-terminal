/** Display formatting. Values are formatted, never recalculated. */

const currencyFormatter = new Intl.NumberFormat(undefined, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function isPresentNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

export function formatCurrency(amount) {
  return isPresentNumber(amount) ? currencyFormatter.format(amount) : '—'
}

export function formatQuantity(quantity) {
  if (!isPresentNumber(quantity)) return '—'
  const fractionDigits = Number.isInteger(quantity) ? 0 : 4
  return quantity.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })
}

/** Percentage points from the service (2 means 2%). */
export function formatPercentPoints(percentPoints, fractionDigits = 2) {
  if (!isPresentNumber(percentPoints)) return '—'
  return `${percentPoints.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}%`
}

export function formatPrice(price) {
  if (!isPresentNumber(price)) return '—'
  const fractionDigits = Math.abs(price) >= 1000 ? 2 : Math.abs(price) >= 1 ? 2 : 6
  return price.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: Math.max(fractionDigits, 4),
  })
}

/**
 * Optional calendar value (actual/estimate/previous). A legitimate 0 is preserved;
 * only null/undefined render as an em dash.
 */
export function formatReleaseValue(value, unit) {
  if (!isPresentNumber(value)) return null
  const formattedNumber = value.toLocaleString(undefined, { maximumFractionDigits: 3 })
  return unit ? `${formattedNumber}${unit === '%' ? '%' : ` ${unit}`}` : formattedNumber
}

export function formatCountdown(millisecondsUntil) {
  if (millisecondsUntil <= 0) return 'now'
  const totalSeconds = Math.floor(millisecondsUntil / 1000)
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

export function localTimeZoneLabel() {
  const timeZoneName = Intl.DateTimeFormat().resolvedOptions().timeZone
  const offsetPart = new Intl.DateTimeFormat(undefined, { timeZoneName: 'shortOffset' })
    .formatToParts(new Date())
    .find((part) => part.type === 'timeZoneName')
  return offsetPart ? `${timeZoneName} (${offsetPart.value})` : timeZoneName
}

const releaseTimeFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
})

export function formatReleaseTime(date) {
  return releaseTimeFormatter.format(date)
}

const clockFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

export function formatClockTime(date) {
  return date ? clockFormatter.format(date) : '—'
}
