import { useCallback, useMemo, useState } from 'react'

import { FinnhubKeyContext } from '../hooks/useFinnhubKey.js'
import { useOnEngineConnected } from '../hooks/useTerminalSocket.js'
import { engineApi } from '../services/api.js'
import FinnhubKeyDialog from './FinnhubKeyDialog.jsx'

/** Set when the user closes the key prompt, so it doesn't reappear on every launch. */
const KEY_PROMPT_DISMISSED_STORAGE_KEY = 'maison.finnhubKeyPrompt.dismissed'

function readPromptDismissed() {
  try {
    return window.localStorage.getItem(KEY_PROMPT_DISMISSED_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function rememberPromptDismissed(isDismissed) {
  try {
    if (isDismissed) window.localStorage.setItem(KEY_PROMPT_DISMISSED_STORAGE_KEY, 'true')
    else window.localStorage.removeItem(KEY_PROMPT_DISMISSED_STORAGE_KEY)
  } catch {
    // Storage unavailable: the prompt may simply show again next launch.
  }
}

/**
 * Asks each user for their own free Finnhub key the first time the engine reports none,
 * and lets them bring the prompt back later ("Add key" in the catalyst strip).
 */
export default function FinnhubKeyProvider({ children }) {
  const [keyStatus, setKeyStatus] = useState({ status: 'unknown', calendarAvailable: null })
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [keyVersion, setKeyVersion] = useState(0)

  const loadKeyStatus = useCallback(async () => {
    try {
      const statusBody = await engineApi.getFinnhubKeyStatus()
      setKeyStatus({
        status: statusBody.configured ? 'configured' : 'missing',
        calendarAvailable: statusBody.calendar_available ?? null,
      })
      if (!statusBody.configured && !readPromptDismissed()) setIsDialogOpen(true)
    } catch {
      setKeyStatus((previousStatus) => ({ ...previousStatus, status: 'unknown' }))
    }
  }, [])
  useOnEngineConnected(loadKeyStatus)

  const openKeyDialog = useCallback(() => setIsDialogOpen(true), [])
  const dismissKeyDialog = useCallback(() => {
    rememberPromptDismissed(true)
    setIsDialogOpen(false)
  }, [])
  const closeKeyDialog = useCallback(() => setIsDialogOpen(false), [])
  const saveKey = useCallback(async (apiKey) => {
    const statusBody = await engineApi.saveFinnhubKey(apiKey)
    rememberPromptDismissed(false)
    setKeyStatus({ status: 'configured', calendarAvailable: statusBody.calendar_available ?? null })
    setKeyVersion((previousVersion) => previousVersion + 1)
    return statusBody
  }, [])

  const contextValue = useMemo(
    () => ({ ...keyStatus, keyVersion, isDialogOpen, openKeyDialog, dismissKeyDialog, saveKey }),
    [keyStatus, keyVersion, isDialogOpen, openKeyDialog, dismissKeyDialog, saveKey],
  )

  return (
    <FinnhubKeyContext.Provider value={contextValue}>
      {children}
      {isDialogOpen && <FinnhubKeyDialog onDismiss={dismissKeyDialog} onSave={saveKey} onDone={closeKeyDialog} />}
    </FinnhubKeyContext.Provider>
  )
}
