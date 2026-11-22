/**
 * What each check in the engine's "maison_core" summary measures, in plain language.
 * These describe what the chart has done; they are not predictions or recommendations.
 */

export const SIGNAL_LABELS = {
  ema_stack: 'EMA stack (9 / 21 / 50)',
  trend_filter: 'Long-term trend (200 EMA)',
  rsi: 'Momentum (RSI 14)',
  macd: 'MACD (12, 26, 9)',
  bollinger: 'Bollinger Bands (20, 2)',
}

export const SIGNAL_MEANINGS = {
  ema_stack:
    'Shorter averages above longer ones means recent prices have been rising faster than the broader trend; the reverse means falling.',
  trend_filter: 'Price above its 200-bar average is commonly read as a long-term uptrend; below it, a downtrend.',
  rsi: 'Above 50 means recent gains outweigh losses. Above 70 or below 30 flags an unusually stretched move.',
  macd: 'MACD above its signal line means short-term momentum is improving; below means it is fading.',
  bollinger: 'A close outside the bands means the latest move is large compared with recent volatility.',
}

export const SCORING_EXPLANATION =
  'Each check votes +1 (bullish), −1 (bearish) or 0 (neutral). A total of +2 or more reads bullish, −2 or less bearish, anything between neutral.'

export function describeBiasForRisk(bias) {
  if (bias === 'bullish') {
    return 'The checks mostly agree the chart has been trending up. Trends can reverse at any time, so a stop still defines your risk.'
  }
  if (bias === 'bearish') {
    return 'The checks mostly agree the chart has been trending down. That is useful context for long positions, not a forecast.'
  }
  return 'The checks disagree, so the direction is unclear. Choppy markets tend to hit tight stops more often.'
}
