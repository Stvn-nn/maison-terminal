import { isTauri } from '@tauri-apps/api/core'

import { ENGINE_LOG_LOCATION, ENGINE_START_COMMAND } from '../config.js'
import { cn } from '../lib/cn.js'

/**
 * What to do when the engine is unreachable.
 * - Desktop app: the engine is bundled and started automatically, so point to its log.
 * - Browser preview: the engine must be started by hand, so show the exact command.
 */
export default function EngineStartHint({ className }) {
  if (isTauri()) {
    return (
      <span className={cn('text-[11px] text-muted', className)}>
        The app starts the engine automatically. If it stays offline, check{' '}
        <code className="rounded bg-surface-raised px-1.5 py-px text-bone/80" data-selectable>
          {ENGINE_LOG_LOCATION}
        </code>
      </span>
    )
  }
  return (
    <code
      className={cn('rounded bg-surface-raised px-1.5 py-px text-[11px] text-bone/80', className)}
      data-selectable
    >
      {ENGINE_START_COMMAND}
    </code>
  )
}
