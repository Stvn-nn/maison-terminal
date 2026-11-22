import { useMemo, useState } from 'react'

import { ChartInsightsContext, EMPTY_CHART_INSIGHTS } from '../hooks/useChartInsights.js'

/** Holds what the chart shows so the drawer's Insights tab can describe it. */
export default function ChartInsightsProvider({ children }) {
  const [chartInsights, setChartInsights] = useState(EMPTY_CHART_INSIGHTS)
  const contextValue = useMemo(() => ({ chartInsights, setChartInsights }), [chartInsights])
  return <ChartInsightsContext.Provider value={contextValue}>{children}</ChartInsightsContext.Provider>
}
