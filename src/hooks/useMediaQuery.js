import { useCallback, useSyncExternalStore } from 'react'

/** True while the CSS media query matches (e.g. '(max-width: 899px)'). */
export function useMediaQuery(mediaQuery) {
  const subscribe = useCallback(
    (notifyChange) => {
      const mediaQueryList = window.matchMedia(mediaQuery)
      mediaQueryList.addEventListener('change', notifyChange)
      return () => mediaQueryList.removeEventListener('change', notifyChange)
    },
    [mediaQuery],
  )
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(mediaQuery).matches,
    () => false,
  )
}
