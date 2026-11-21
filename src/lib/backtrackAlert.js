/**
 * State machine for the backtrack banner.
 * - BACKTRACK_REQUIRED while visible: coalesced (no second banner, no re-announcement).
 * - BACKTRACK_REQUIRED while hidden (never shown, dismissed, or cleared): surfaces again.
 * - BACKTRACK_CLEARED (the service's documented clearing event): hides the banner.
 * - dismissed: local UI state only; the service defines no acknowledgement message.
 */

export const INITIAL_BACKTRACK_STATE = Object.freeze({
  isVisible: false,
  message: '',
  coalescedCount: 0,
  receivedAt: null,
})

export function backtrackReducer(currentState, action) {
  switch (action.type) {
    case 'required':
      if (currentState.isVisible) {
        return { ...currentState, coalescedCount: currentState.coalescedCount + 1 }
      }
      return { isVisible: true, message: action.message, coalescedCount: 0, receivedAt: action.receivedAt }
    case 'cleared':
    case 'dismissed':
      return currentState.isVisible ? { ...currentState, isVisible: false } : currentState
    default:
      return currentState
  }
}
