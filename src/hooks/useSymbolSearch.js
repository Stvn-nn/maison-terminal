import { useEffect, useState } from 'react'

import { bestSymbolMatch } from '../lib/marketSymbols.js'
import { engineApi, isAbortError } from '../services/api.js'

export const SEARCH_DEBOUNCE_MS = 200

/**
 * Live symbol suggestions while the user types (GET /api/v1/market/search), debounced and
 * with stale responses dropped, like the symbol search on charting platforms.
 */
export function useSymbolSearch(query) {
  const trimmedQuery = query.trim()
  const [searchState, setSearchState] = useState({ query: '', matches: [], status: 'idle', error: null })

  useEffect(() => {
    if (!trimmedQuery) return undefined
    const requestController = new AbortController()
    const debounceTimer = setTimeout(async () => {
      setSearchState((previousState) => ({ ...previousState, status: 'loading' }))
      try {
        const searchResult = await engineApi.searchSymbols(trimmedQuery, { signal: requestController.signal })
        setSearchState({ query: trimmedQuery, matches: searchResult.matches, status: 'ready', error: null })
      } catch (searchError) {
        if (isAbortError(searchError)) return
        setSearchState({ query: trimmedQuery, matches: [], status: 'error', error: searchError })
      }
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(debounceTimer)
      requestController.abort()
    }
  }, [trimmedQuery])

  if (!trimmedQuery) return { query: '', matches: [], status: 'idle', error: null }
  // Never show suggestions for an older query while the current one is loading.
  if (searchState.query !== trimmedQuery) return { query: trimmedQuery, matches: [], status: 'loading', error: null }
  return searchState
}

const resolvedSymbolCache = new Map()

/**
 * The market-data instrument for a ticker read off the chart window title, so the Screen
 * source can show real, live prices for the chart the user is looking at.
 * `isResolving` is true while the lookup runs; `match` is null when the provider has none.
 */
export function useResolvedSymbol(screenSymbol) {
  const [resolution, setResolution] = useState({ screenSymbol: null, match: null })

  useEffect(() => {
    if (!screenSymbol || resolvedSymbolCache.has(screenSymbol)) return undefined
    const requestController = new AbortController()
    engineApi
      .searchSymbols(screenSymbol.replace(/\d*!$/, ''), { signal: requestController.signal })
      .then((searchResult) => {
        const match = bestSymbolMatch(screenSymbol, searchResult.matches)
        resolvedSymbolCache.set(screenSymbol, match)
        setResolution({ screenSymbol, match })
      })
      .catch((resolveError) => {
        // Provider unreachable: fall back to the screen-read candles (retried next time).
        if (!isAbortError(resolveError)) setResolution({ screenSymbol: null, match: null, failedSymbol: screenSymbol })
      })
    return () => requestController.abort()
  }, [screenSymbol])

  if (!screenSymbol) return { isResolving: false, match: null }
  if (resolvedSymbolCache.has(screenSymbol)) return { isResolving: false, match: resolvedSymbolCache.get(screenSymbol) }
  if (resolution.screenSymbol === screenSymbol) return { isResolving: false, match: resolution.match }
  return { isResolving: resolution.failedSymbol !== screenSymbol, match: null }
}
