import { ChartWatchContext, useChartWatchController } from '../hooks/useChartWatch.js'

/** One chart-watch controller for the whole app (title bar and chart share it). */
export default function ChartWatchProvider({ children }) {
  const chartWatch = useChartWatchController()
  return <ChartWatchContext.Provider value={chartWatch}>{children}</ChartWatchContext.Provider>
}
