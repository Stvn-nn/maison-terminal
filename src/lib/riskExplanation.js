/**
 * Plain-language explanation of a sizing result from the engine. It restates what the
 * engine's numbers mean (loss at the stop, position value, R multiples); it does not
 * recommend a trade. Gains for targets are shares x distance from entry, shown as context.
 */

import { formatCurrency, formatPercentPoints, formatPrice, formatQuantity, isPresentNumber } from './format.js'

/** A common rule of thumb, quoted for context only. */
export const COMMON_RISK_GUIDELINE_PCT = { low: 1, high: 2 }

export function explainSizingResult(sizingResult) {
  if (!sizingResult) return []
  const explanations = []
  const shares = sizingResult.shares
  const hasStop = isPresentNumber(sizingResult.stop_price) && isPresentNumber(sizingResult.risk_amount)
  const riskPct = sizingResult.risk_pct_of_equity
  const notionalPct = sizingResult.notional_pct_of_equity

  if (!isPresentNumber(shares) || shares <= 0) {
    return [
      {
        key: 'zero-shares',
        tone: 'caution',
        text: 'The position rounds down to zero shares, so nothing would be bought. Raise the amount or tighten the stop.',
      },
    ]
  }

  if (hasStop) {
    const accountShare = isPresentNumber(riskPct) ? `, which is ${formatPercentPoints(riskPct)} of your account` : ''
    explanations.push({
      key: 'loss-at-stop',
      tone: 'neutral',
      text: `If price reaches your stop at ${formatPrice(sizingResult.stop_price)}, this position loses about ${formatCurrency(sizingResult.risk_amount)}${accountShare}.`,
    })
  } else {
    explanations.push({
      key: 'no-stop',
      tone: 'caution',
      text: 'No stop-loss was entered, so nothing caps how much this position could lose. Add a stop-loss price to see your risk.',
    })
  }

  const accountValueShare = isPresentNumber(notionalPct) ? ` (${formatPercentPoints(notionalPct)} of your account)` : ''
  explanations.push({
    key: 'position-value',
    tone: 'neutral',
    text: `You would hold ${formatQuantity(shares)} shares worth ${formatCurrency(sizingResult.notional)}${accountValueShare}.`,
  })
  if (isPresentNumber(notionalPct) && notionalPct > 100) {
    explanations.push({
      key: 'leverage',
      tone: 'caution',
      text: 'That is more than your whole account, so it would need margin (borrowed money), which magnifies both gains and losses.',
    })
  }

  const firstTarget = sizingResult.targets?.[0]
  const lastTarget = sizingResult.targets?.at(-1)
  if (hasStop && firstTarget && lastTarget) {
    const gainAt = (target) => formatCurrency(shares * Math.abs(target.price - sizingResult.entry_price))
    explanations.push({
      key: 'r-multiples',
      tone: 'neutral',
      text: `One "R" is the amount at risk (${formatCurrency(sizingResult.risk_amount)}). The ${firstTarget.r_multiple}R target at ${formatPrice(firstTarget.price)} would gain about ${gainAt(firstTarget)}; the ${lastTarget.r_multiple}R target at ${formatPrice(lastTarget.price)} about ${gainAt(lastTarget)}.`,
    })
  }

  if (isPresentNumber(riskPct)) {
    const { low, high } = COMMON_RISK_GUIDELINE_PCT
    explanations.push({
      key: 'guideline',
      tone: riskPct > high ? 'caution' : 'neutral',
      text: `For context, a common rule of thumb is to risk about ${low}–${high}% of the account per trade. This trade risks ${formatPercentPoints(riskPct)}.`,
    })
  }

  if (sizingResult.mode === 'risk_to_stop' && hasStop) {
    explanations.push({
      key: 'rounding',
      tone: 'neutral',
      text: 'Shares are rounded down, so the actual risk can be slightly below your budget, never above it.',
    })
  }
  return explanations
}
