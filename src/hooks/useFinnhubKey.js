import { createContext, useContext } from 'react'

/**
 * The user's own Finnhub key (news and economic calendar): whether one is set, the
 * "Add your key" dialog, and `keyVersion`, which changes after a key is saved so feeds
 * can reload. The key itself never reaches the interface after it is submitted.
 */
export const FinnhubKeyContext = createContext(null)

export function useFinnhubKey() {
  const finnhubKey = useContext(FinnhubKeyContext)
  if (finnhubKey === null) throw new Error('useFinnhubKey must be used inside FinnhubKeyProvider')
  return finnhubKey
}
