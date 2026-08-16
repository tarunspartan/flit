import {useEffect} from 'react'

/**
 * Keeps the screen awake while bytes are moving.
 *
 * A phone that locks mid-transfer freezes the tab: timers stop, the data
 * channel goes quiet, and the transfer stalls with no way for either side to
 * tell that from a network problem. Holding a screen wake lock for the duration
 * is the only thing a web app can do about it — there is no way to keep a page
 * running once the OS decides to suspend it.
 *
 * The lock is deliberately scoped to active transfers. Holding it for the whole
 * session would keep a phone awake all afternoon because a room happens to be
 * open, which is its own kind of broken.
 *
 * Unsupported on iOS below 16.4 and on Firefox, where this is a no-op and a
 * long transfer still needs the screen left on.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    const api = (navigator as {wakeLock?: {request: (t: 'screen') => Promise<WakeLockHandle>}})
      .wakeLock
    if (!active || !api) return

    let sentinel: WakeLockHandle | null = null
    let dropped = false

    const acquire = async () => {
      // The request only succeeds while the page is visible, and the browser
      // releases the lock on its own every time the page is hidden — so this
      // has to be re-taken on return, not just requested once.
      if (dropped || document.visibilityState !== 'visible') return
      try {
        sentinel = await api.request('screen')
      } catch {
        // Denied, or the page went away mid-request. Nothing to recover.
      }
    }

    const onVisibility = () => void acquire()
    void acquire()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      dropped = true
      document.removeEventListener('visibilitychange', onVisibility)
      void sentinel?.release().catch(() => {})
      sentinel = null
    }
  }, [active])
}

interface WakeLockHandle {
  release: () => Promise<void>
}
