import {useEffect, useState} from 'react'
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
