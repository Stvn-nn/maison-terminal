import { Check, Copy, Eye, EyeOff, LoaderCircle, X } from 'lucide-react'
import { useEffect, useId, useState } from 'react'

import maisonLogo from '../assets/maison-logo.png'
import { cn } from '../lib/cn.js'

const FINNHUB_SIGNUP_URL = 'https://finnhub.io/register'
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,80}$/

function describeSaveError(saveError) {
  if (saveError?.code === 'finnhub_key_invalid') return 'Finnhub didn’t accept that key. Check it and try again.'
  if (saveError?.code === 'validation_error') return 'That doesn’t look like a Finnhub key (letters and numbers only).'
  if (saveError?.code === 'engine_unreachable') return 'The analytical service is offline. Try again once it has started.'
  if (saveError?.code === 'finnhub_unavailable') return 'Couldn’t reach Finnhub to check the key. Check your connection.'
  if (saveError?.code === 'key_not_saved') return 'The key works, but it couldn’t be saved for next time.'
  return saveError?.message ?? 'Couldn’t save the key.'
}

/**
 * "Add your Finnhub key" prompt: a rounded panel with the MT mark at the top left and a
 * close button at the top right. The key is checked with Finnhub by the engine and stored
 * only on this computer.
 */
export default function FinnhubKeyDialog({ onDismiss, onSave, onDone }) {
  const titleId = useId()
  const descriptionId = useId()
  const [apiKey, setApiKey] = useState('')
  const [isKeyVisible, setIsKeyVisible] = useState(false)
  const [saveState, setSaveState] = useState({ phase: 'idle', error: null, calendarAvailable: null })
  const [hasCopiedLink, setHasCopiedLink] = useState(false)
  const trimmedKey = apiKey.trim()
  const isSaving = saveState.phase === 'saving'

  useEffect(() => {
    const closeOnEscape = (keyEvent) => {
      if (keyEvent.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onDismiss])

  const submitKey = async (submitEvent) => {
    submitEvent.preventDefault()
    if (!KEY_PATTERN.test(trimmedKey)) {
      setSaveState({ phase: 'failed', error: { code: 'validation_error' }, calendarAvailable: null })
      return
    }
    setSaveState({ phase: 'saving', error: null, calendarAvailable: null })
    try {
      const keyStatus = await onSave(trimmedKey)
      setApiKey('')
      setSaveState({ phase: 'saved', error: null, calendarAvailable: keyStatus.calendar_available ?? null })
    } catch (saveError) {
      setSaveState({ phase: 'failed', error: saveError, calendarAvailable: null })
    }
  }

  const copySignupLink = async () => {
    try {
      await navigator.clipboard.writeText(FINNHUB_SIGNUP_URL)
      setHasCopiedLink(true)
    } catch {
      setHasCopiedLink(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 backdrop-blur-[2px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="relative w-full max-w-md rounded-3xl border border-divider bg-surface p-6 shadow-[0_24px_64px_rgba(0,0,0,0.6)]"
      >
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Close"
          title="Not now (you can add a key later from the catalyst strip)"
          className="absolute top-4 right-4 rounded-full p-1.5 text-muted transition-colors hover:bg-surface-raised hover:text-bone"
        >
          <X size={16} aria-hidden="true" />
        </button>

        <div className="flex items-center gap-3 pr-8">
          <img src={maisonLogo} alt="Maison Terminal" className="size-10 rounded-xl ring-1 ring-divider" draggable={false} />
          <h2 id={titleId} className="font-serif text-[22px] leading-tight font-semibold text-bone">
            {saveState.phase === 'saved' ? 'Key saved' : 'Add your Finnhub key'}
          </h2>
        </div>

        {saveState.phase === 'saved' ? (
          <div className="mt-4 flex flex-col gap-4">
            <p id={descriptionId} className="flex gap-2 text-[13px] leading-relaxed text-muted">
              <Check size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-gain" />
              <span>
                News is on.{' '}
                {saveState.calendarAvailable === false
                  ? 'The economic calendar needs a paid Finnhub plan, so the strip will say it’s unavailable.'
                  : 'The economic calendar is loading.'}
              </span>
            </p>
            <button
              type="button"
              onClick={onDone}
              className="self-end rounded-full bg-accent px-4 py-1.5 text-[12px] font-semibold text-obsidian hover:bg-accent-strong"
            >
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={submitKey} className="mt-4 flex flex-col gap-4">
            <p id={descriptionId} className="text-[13px] leading-relaxed text-muted">
              Market news and upcoming economic releases come from Finnhub. A key is free: sign up,
              then copy the key from your Finnhub dashboard. It is checked with Finnhub and stored
              only on this computer.
            </p>
            <p className="flex items-center gap-2 text-[12px]">
              <a
                href={FINNHUB_SIGNUP_URL}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline"
                data-selectable
              >
                finnhub.io/register
              </a>
              <button
                type="button"
                onClick={copySignupLink}
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] text-muted hover:bg-surface-raised hover:text-bone"
              >
                {hasCopiedLink ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
                {hasCopiedLink ? 'Copied' : 'Copy link'}
              </button>
            </p>

            <label className="flex flex-col gap-1.5">
              <span className="text-[10px] font-medium tracking-[0.14em] text-muted uppercase">API key</span>
              <span
                className={cn(
                  'flex items-center gap-2 rounded-xl border bg-obsidian px-3 py-2 transition-colors',
                  saveState.phase === 'failed' ? 'border-loss/60' : 'border-divider focus-within:border-accent',
                )}
              >
                <input
                  type={isKeyVisible ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(changeEvent) => setApiKey(changeEvent.target.value)}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste your key"
                  aria-invalid={saveState.phase === 'failed'}
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-bone outline-none placeholder:text-muted"
                  data-selectable
                />
                <button
                  type="button"
                  onClick={() => setIsKeyVisible((wasVisible) => !wasVisible)}
                  aria-label={isKeyVisible ? 'Hide key' : 'Show key'}
                  className="text-muted hover:text-bone"
                >
                  {isKeyVisible ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                </button>
              </span>
            </label>

            {saveState.phase === 'failed' && (
              <p role="alert" className="-mt-2 text-[12px] text-loss">
                {describeSaveError(saveState.error)}
              </p>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onDismiss}
                className="rounded-full px-3.5 py-1.5 text-[12px] text-muted hover:bg-surface-raised hover:text-bone"
              >
                Not now
              </button>
              <button
                type="submit"
                disabled={isSaving || trimmedKey.length === 0}
                className="inline-flex items-center gap-2 rounded-full bg-accent px-4 py-1.5 text-[12px] font-semibold text-obsidian shadow-[0_2px_10px_rgba(106,134,176,0.35)] hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSaving && <LoaderCircle size={13} aria-hidden="true" className="motion-safe:animate-spin" />}
                {isSaving ? 'Checking…' : 'Save key'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
