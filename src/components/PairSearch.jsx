import { LoaderCircle, Search, X } from 'lucide-react'
import { useId, useRef, useState } from 'react'

import { useSymbolSearch } from '../hooks/useSymbolSearch.js'
import { cn } from '../lib/cn.js'
import { assetKindInfo } from '../lib/marketSymbols.js'

/** Small type badge drawn next to a ticker (stock, ETF, index, forex, crypto, futures…). */
export function AssetKindIcon({ kind, size = 13, className }) {
  const { Icon, label, colorClass } = assetKindInfo(kind)
  return (
    <span title={label} className={cn('inline-flex shrink-0', colorClass, className)}>
      <Icon size={size} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  )
}

/**
 * Type-ahead pair search: suggestions appear while typing, each with an icon for its asset
 * type, exchange and full name. Arrow keys move through them, Enter picks, Escape closes.
 *
 * @param {{selectedPair: {symbol: string, name: string, kind: string} | null,
 *          onSelect: (pair: object) => void, onClear: () => void, autoFocus?: boolean,
 *          className?: string}} props
 */
export default function PairSearch({ selectedPair, onSelect, onClear, autoFocus = false, className }) {
  const listboxId = useId()
  const inputRef = useRef(null)
  const [query, setQuery] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const search = useSymbolSearch(query)
  const matches = search.matches
  const showList = isOpen && query.trim().length > 0

  const choosePair = (pair) => {
    onSelect(pair)
    setQuery('')
    setIsOpen(false)
    inputRef.current?.blur()
  }

  const handleKeyDown = (keyEvent) => {
    if (keyEvent.key === 'ArrowDown' || keyEvent.key === 'ArrowUp') {
      keyEvent.preventDefault()
      setIsOpen(true)
      if (matches.length === 0) return
      const step = keyEvent.key === 'ArrowDown' ? 1 : -1
      setHighlightedIndex((currentIndex) => (currentIndex + step + matches.length) % matches.length)
    } else if (keyEvent.key === 'Enter') {
      const highlightedMatch = matches[highlightedIndex] ?? matches[0]
      if (showList && highlightedMatch) {
        keyEvent.preventDefault()
        choosePair(highlightedMatch)
      }
    } else if (keyEvent.key === 'Escape') {
      setIsOpen(false)
      setQuery('')
      inputRef.current?.blur()
    }
  }

  let listStatus = null
  if (search.status === 'loading' && matches.length === 0) listStatus = 'Searching…'
  else if (search.status === 'error') listStatus = 'Search unavailable. Is the engine online?'
  else if (search.status === 'ready' && matches.length === 0) listStatus = `No pairs match “${query.trim()}”`

  return (
    <div className={cn('relative', className)}>
      <div
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-full border bg-obsidian pr-1.5 pl-2.5 transition-colors',
          isOpen ? 'border-accent' : 'border-divider hover:border-accent/50',
        )}
      >
        {selectedPair && !isOpen && !query ? (
          <AssetKindIcon kind={selectedPair.kind} size={12} />
        ) : search.status === 'loading' ? (
          <LoaderCircle size={12} aria-hidden="true" className="shrink-0 text-muted motion-safe:animate-spin" />
        ) : (
          <Search size={12} aria-hidden="true" className="shrink-0 text-muted" />
        )}
        <input
          ref={inputRef}
          role="combobox"
          aria-label="Search pair or symbol"
          aria-expanded={showList}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={showList && matches[highlightedIndex] ? `${listboxId}-${highlightedIndex}` : undefined}
          autoFocus={autoFocus}
          spellCheck={false}
          autoComplete="off"
          value={query}
          placeholder={selectedPair ? selectedPair.symbol : 'Search pair…'}
          onChange={(changeEvent) => {
            setQuery(changeEvent.target.value)
            setHighlightedIndex(0)
            setIsOpen(true)
          }}
          onFocus={() => setIsOpen(true)}
          onBlur={() => setIsOpen(false)}
          onKeyDown={handleKeyDown}
          className={cn(
            'w-28 min-w-0 bg-transparent text-[12px] text-bone outline-none lg:w-36',
            selectedPair ? 'placeholder:font-semibold placeholder:text-bone' : 'placeholder:text-muted',
          )}
          data-selectable
        />
        {selectedPair && !query && (
          <button
            type="button"
            aria-label={`Clear ${selectedPair.symbol}`}
            title="Clear pair"
            onMouseDown={(mouseEvent) => mouseEvent.preventDefault()}
            onClick={onClear}
            className="rounded-full p-0.5 text-muted hover:bg-surface-raised hover:text-bone"
          >
            <X size={11} aria-hidden="true" />
          </button>
        )}
      </div>

      {showList && (
        <div className="absolute top-full right-0 z-40 mt-1.5 w-[min(24rem,calc(100vw-5rem))] overflow-hidden rounded-xl border border-divider bg-surface shadow-[0_12px_32px_rgba(0,0,0,0.55)]">
          {matches.length > 0 && (
            <ul id={listboxId} role="listbox" aria-label="Matching pairs" className="max-h-80 overflow-x-hidden overflow-y-auto py-1">
              {matches.map((match, matchIndex) => (
                <li
                  key={`${match.symbol}-${matchIndex}`}
                  id={`${listboxId}-${matchIndex}`}
                  role="option"
                  aria-selected={matchIndex === highlightedIndex}
                  onMouseDown={(mouseEvent) => mouseEvent.preventDefault()}
                  onMouseEnter={() => setHighlightedIndex(matchIndex)}
                  onClick={() => choosePair(match)}
                  className={cn(
                    'flex cursor-pointer items-center gap-2.5 px-3 py-2 text-[12px]',
                    matchIndex === highlightedIndex ? 'bg-accent/15' : 'hover:bg-surface-raised',
                  )}
                >
                  <AssetKindIcon kind={match.kind} size={14} />
                  <span className="w-20 shrink-0 truncate font-semibold text-bone">{match.symbol}</span>
                  <span className="min-w-0 flex-1 truncate text-muted">{match.name}</span>
                  <span className="max-w-[40%] shrink-0 truncate text-[10px] tracking-wide text-muted/80 uppercase">
                    {assetKindInfo(match.kind).label}
                    {match.exchange ? ` · ${match.exchange}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {listStatus && (
            <p className="px-3 py-2.5 text-[12px] text-muted" role="status">
              {listStatus}
            </p>
          )}
          <p className="border-t border-divider px-3 py-1.5 text-[10px] text-muted/80">
            Suggestions and prices from Yahoo Finance · may be delayed
          </p>
        </div>
      )}
    </div>
  )
}
