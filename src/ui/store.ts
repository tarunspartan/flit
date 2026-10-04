import {useSyncExternalStore} from 'react'
import {PROGRESS_EMIT_INTERVAL_MS} from '../lib/core/config.ts'
import {SessionManager, type SessionSnapshot} from '../lib/session/SessionManager.ts'

/**
 * React bridge.
 *
 * A running transfer changes state once per chunk — hundreds of times a second
 * on a fast link. Notifications are coalesced to a fixed cadence so the render
 * loop never becomes the bottleneck, using timers rather than rAF so a
 * backgrounded tab still updates.
 */
function createStore(manager: SessionManager) {
  let snapshot = manager.snapshot()
  const listeners = new Set<() => void>()
  let scheduled = false
  let lastEmit = 0

  const flush = () => {
    scheduled = false
    lastEmit = Date.now()
    snapshot = manager.snapshot()
    for (const listener of listeners) listener()
  }

  manager.subscribe(() => {
    if (scheduled) return
    scheduled = true
    setTimeout(flush, Math.max(0, PROGRESS_EMIT_INTERVAL_MS - (Date.now() - lastEmit)))
  })

  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot
  }
}

export const session = new SessionManager()
const store = createStore(session)

// The session is a singleton holding live connections, and cannot be swapped
// in place: a hot update used to start a second SessionManager beside the
// first, with no room, and the page sat on "Getting ready…". Accepting updates
// here makes this module the boundary for every change beneath it, so any of
// them reloads the page instead. (Written without `?.`: Vite finds `accept`
// by reading the source.)
if (import.meta.hot) import.meta.hot.accept(() => location.reload())

export function useSession(): SessionSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
