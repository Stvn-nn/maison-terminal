import BacktrackPrompt from './components/BacktrackPrompt.jsx'
import CatalystFeed from './components/CatalystFeed.jsx'
import ChartCanvas from './components/ChartCanvas.jsx'
import ChartWatchProvider from './components/ChartWatchProvider.jsx'
import SizingDrawer from './components/SizingDrawer.jsx'
import TitleBar from './components/TitleBar.jsx'

/** Maison Terminal workspace: title bar, catalyst strip, dominant chart, sizing drawer. */
export default function App() {
  return (
    <ChartWatchProvider>
      <div className="flex h-full min-h-0 flex-col bg-obsidian text-bone">
        <TitleBar />
        <CatalystFeed />
        <main className="relative flex min-h-0 flex-1">
          <section aria-label="Chart workspace" className="relative min-w-0 flex-1">
            <ChartCanvas />
            <BacktrackPrompt />
          </section>
          <SizingDrawer />
        </main>
      </div>
    </ChartWatchProvider>
  )
}
