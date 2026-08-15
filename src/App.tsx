import {useEffect, useRef, useState} from 'react'
import {codeFromUrl} from './lib/session/RoomManager.ts'
import {cameFromShare, takeSharedFiles} from './lib/utils/shareTarget.ts'
import {Icon, Spinner} from './ui/components/common.tsx'
import {DevicePanel} from './ui/components/DevicePanel.tsx'
import {RoomScreen} from './ui/components/RoomScreen.tsx'
import {Sidebar} from './ui/components/Sidebar.tsx'
import {useAppUpdate} from './ui/pwa.ts'
import {session, useSession} from './ui/store.ts'
import {useTheme} from './ui/theme.ts'

export function App() {
  const state = useSession()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [devicesOpen, setDevicesOpen] = useState(false)
  useTheme() // Applies the stored preference to <html> on mount.
  useAutoRoom()
  const dragging = useWindowDrop(state.status === 'open')
  const update = useAppUpdate()
  useUnloadGuard(session.hasActiveTransfers())

  return (
    <div className="app">
      {/* No nav bar — just the floating controls. */}
      <div className="fabs">
        {state.peers.length > 0 && (
          <button
            type="button"
            className="fab fab--devices"
            onClick={() => setDevicesOpen(open => !open)}
            aria-expanded={devicesOpen}
            aria-label={`${state.peers.length} device${
              state.peers.length === 1 ? '' : 's'
            } connected — show list`}
          >
            <span className="fab__dot" aria-hidden="true" />
            {state.peers.length} connected
          </button>
        )}
        <button
          type="button"
          className="fab"
          onClick={() => setSidebarOpen(true)}
          aria-label="Settings"
        >
          <Icon name="settings" />
        </button>
      </div>

      {devicesOpen && state.peers.length > 0 && (
        <DevicePanel state={state} onClose={() => setDevicesOpen(false)} />
      )}

      <main className="main">
        {/*
          Driven by whether a signaling socket is genuinely open, not by
          `navigator.onLine`. And only while nothing is connected: once devices
          are paired, signaling is irrelevant to the transfer.
        */}
        {!state.signalingReady && state.peers.length === 0 && (
          <div className="banner banner--warn">
            <Icon name="alert" />
            <div>
              <strong>Can't reach the internet</strong>
              <span>
                Devices need it briefly to find each other. Pairing won't work until the connection
                is back — files themselves always move directly between devices.
              </span>
            </div>
          </div>
        )}

        {update.ready && (
          <div className="banner banner--info">
            <Icon name="retry" />
            <div>
              <strong>A new version is ready</strong>
              <span>Reload when you're not in the middle of a transfer.</span>
            </div>
            <button type="button" className="button button--small" onClick={update.apply}>
              Reload
            </button>
          </div>
        )}

        {state.error && <ErrorBanner state={state} />}
        {state.status === 'starting' && (
          <div className="starting">
            <Spinner label="Getting ready…" />
          </div>
        )}
        {state.status === 'open' && <RoomScreen state={state} />}
        {state.status === 'ended' && (
          <div className="ended">
            <h2>Disconnected</h2>
            <p>Files are no longer being shared and your code has stopped working.</p>
            <button
              type="button"
              className="button button--primary"
              onClick={() => void session.openRoom()}
            >
              Start over
            </button>
          </div>
        )}
      </main>

      {dragging && (
        <div className="dropveil">
          <Icon name="upload" size={34} />
          <span>Drop to share</span>
        </div>
      )}

      <Notices notices={state.notices} />
      {sidebarOpen && <Sidebar state={state} onClose={() => setSidebarOpen(false)} />}
    </div>
  )
}

function ErrorBanner({state}: {state: ReturnType<typeof useSession>}) {
  if (!state.error) return null
  return (
    <div className="banner banner--error">
      <Icon name="alert" />
      <div>
        <strong>{state.error.title}</strong>
        <span>{state.error.message}</span>
      </div>
      <button type="button" className="notice__close" onClick={() => session.clearError()}>
        <Icon name="x" size={16} />
      </button>
    </div>
  )
}

function Notices({notices}: {notices: ReturnType<typeof useSession>['notices']}) {
  if (notices.length === 0) return null
  return (
    <div className="notices" role="status" aria-live="polite">
      {notices.map(notice => (
        <div key={notice.id} className={`notice notice--${notice.tone}`}>
          <div>
            <strong>{notice.title}</strong>
            <span>{notice.message}</span>
          </div>
          <button
            type="button"
            className="notice__close"
            aria-label="Dismiss"
            onClick={() => session.dismissNotice(notice.id)}
          >
            <Icon name="x" size={16} />
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * No "create room" button: a room exists by the time the page has painted. A
 * scanned link joins that room instead, and the code is stripped from the URL
 * so it isn't left in history or a screenshot.
 *
 * A launch from the OS share sheet lands here too, and the files it carries are
 * added once the room is actually open — sharing into a room that is still
 * starting drops them on the floor.
 */
function useAutoRoom() {
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true

    const code = codeFromUrl()
    const shared = cameFromShare()

    void (async () => {
      let open: boolean
      if (code) {
        history.replaceState(null, '', location.pathname + location.search)
        open = await session.joinRoom(code)
      } else {
        open = await session.openRoom()
      }

      if (!shared) return
      const files = await takeSharedFiles()
      // Same path as a drop or a paste from here on: offered to the room, so
      // whatever connects next is offered them without a second action.
      if (open && files.length > 0) session.shareFiles(files)
    })()
  }, [])
}

/** The whole window is the drop target, not one boxed-off zone. */
function useWindowDrop(enabled: boolean): boolean {
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)

  useEffect(() => {
    if (!enabled) return

    const hasFiles = (event: DragEvent) =>
      [...(event.dataTransfer?.types ?? [])].includes('Files')

    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth.current++
      setDragging(true)
    }
    const onOver = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault()
    }
    const onLeave = (event: DragEvent) => {
      event.preventDefault()
      // Nested elements fire dragleave too; only the outermost one counts.
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    }
    const onDrop = (event: DragEvent) => {
      event.preventDefault()
      depth.current = 0
      setDragging(false)
      const files = [...(event.dataTransfer?.files ?? [])]
      if (files.length > 0) session.shareFiles(files)
    }
    const onPaste = (event: ClipboardEvent) => {
      const files = [...(event.clipboardData?.files ?? [])]
      if (files.length > 0) session.shareFiles(files)
    }

    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('paste', onPaste)
    }
  }, [enabled])

  return dragging
}

function useUnloadGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const handler = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [active])
}
