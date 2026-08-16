import {useEffect, useState, useSyncExternalStore} from 'react'
import {registerSW} from 'virtual:pwa-register'

/**
 * Service-worker registration.
 *
 * Updates are offered, not applied: swapping the app's assets underneath a
 * running transfer would break it. The new version waits until the user says so.
 */
export function useAppUpdate(): {ready: boolean; apply: () => void} {
  const [ready, setReady] = useState(false)
  const [apply, setApply] = useState<() => void>(() => () => {})

  useEffect(() => {
    const updateSW = registerSW({
      onNeedRefresh() {
        setReady(true)
      }
    })
    setApply(() => () => void updateSW(true))
  }, [])

  return {ready, apply}
}

/**
 * The browser's own install event, which is not in the DOM lib because it is
 * not in any standard — Chromium ships it, and that is where installing works.
 */
interface InstallEvent extends Event {
  prompt: () => Promise<void>
}

/** Whether the app is already running as an installed app rather than a tab. */
function isInstalled(): boolean {
  if (window.matchMedia('(display-mode: standalone)').matches) return true
  // iOS predates display-mode and reports it on navigator instead. It has no
  // install prompt either way, so this only suppresses the button.
  return (navigator as {standalone?: boolean}).standalone === true
}

/**
 * Capture starts when this module is evaluated, not when a component mounts.
 *
 * `beforeinstallprompt` fires as soon as the browser decides the app qualifies,
 * which can be before React has rendered anything — and the event does not
 * queue, so a listener attached later simply never sees it. Waiting for an
 * effect made the button appear or not depending on which won the race.
 */
let pending: InstallEvent | null = null
let installedNow = true
const watchers = new Set<() => void>()

function publish(event: InstallEvent | null): void {
  pending = event
  for (const notify of watchers) notify()
}

if (typeof window !== 'undefined') {
  installedNow = isInstalled()

  window.addEventListener('beforeinstallprompt', event => {
    // Suppress the browser's own mini-infobar in favour of our button.
    event.preventDefault()
    if (!installedNow) publish(event as InstallEvent)
  })
  // Fires the moment the install finishes, so the button goes without a reload.
  window.addEventListener('appinstalled', () => {
    installedNow = true
    publish(null)
  })
}

function subscribe(notify: () => void): () => void {
  watchers.add(notify)
  return () => watchers.delete(notify)
}

/**
 * Install-to-home-screen: one press, the browser's own dialog, nothing else.
 *
 * The button appears only when `beforeinstallprompt` has been captured, because
 * that event *is* the only way to install — there is no API to trigger one
 * otherwise. So it stays away on iOS and Firefox, which cannot install web apps
 * programmatically at all, and while Chrome withholds the event, which it does
 * for a while after an app has been uninstalled.
 *
 * The event also never fires when the app is already installed, which is what
 * hides the button in the case that matters.
 *
 * On Android this is the path to a real WebAPK, which is what makes scanned
 * links open in the app instead of bouncing to the browser.
 */
export function useInstallPrompt(): {available: boolean; install: () => void} {
  const event = useSyncExternalStore(
    subscribe,
    () => pending,
    () => null
  )

  return {
    available: event !== null,
    install: () => {
      if (!event) return
      void event.prompt()
      // Single use, whatever the answer: calling prompt() twice throws. The
      // browser offers a fresh event on a later visit if the user declined.
      publish(null)
    }
  }
}
