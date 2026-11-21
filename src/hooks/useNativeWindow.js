import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useCallback, useEffect, useState } from 'react'

/**
 * Native window controls for the frameless Tauri window. In a plain browser preview there
 * is no native window: `isNativeWindow` is false and the actions are no-ops.
 */
export function useNativeWindow() {
  const isNativeWindow = isTauri()
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    if (!isNativeWindow) return undefined
    const appWindow = getCurrentWindow()
    let isDisposed = false
    let stopListening = null

    const syncMaximizedState = async () => {
      const maximized = await appWindow.isMaximized()
      if (!isDisposed) setIsMaximized(maximized)
    }

    syncMaximizedState()
    // Fires for native maximize, snap, double-click on the drag region, and restore.
    appWindow
      .onResized(() => {
        syncMaximizedState()
      })
      .then((unlisten) => {
        if (isDisposed) unlisten()
        else stopListening = unlisten
      })

    return () => {
      isDisposed = true
      stopListening?.()
    }
  }, [isNativeWindow])

  const minimize = useCallback(() => {
    if (isNativeWindow) getCurrentWindow().minimize()
  }, [isNativeWindow])

  const toggleMaximize = useCallback(() => {
    if (isNativeWindow) getCurrentWindow().toggleMaximize()
  }, [isNativeWindow])

  const close = useCallback(() => {
    if (isNativeWindow) getCurrentWindow().close()
  }, [isNativeWindow])

  return { isNativeWindow, isMaximized, minimize, toggleMaximize, close }
}
