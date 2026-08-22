import {useEffect} from 'react'
import type {SessionSnapshot} from '../../lib/session/SessionManager.ts'
import {session} from '../store.ts'
import {Icon, PathCost} from './common.tsx'

/**
 * The connected-device list, opened from the count button.
 *
 * It lives here rather than on the room screen so the home screen stays down to
 * a code and a drop target — the roster is something you check, not something
 * you need in view.
 */
export function DevicePanel({
  state,
  onClose
}: {
  state: SessionSnapshot
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <div className="popover__backdrop" onClick={onClose} />
      <div className="popover" role="dialog" aria-label="Connected devices">
        <h2 className="popover__title">Connected</h2>
        <ul className="popover__list">
          {state.peers.map(peer => (
            <li key={peer.id} className={`peer ${peer.present ? '' : 'peer--away'}`}>
              <span className="peer__icon" aria-hidden="true">
                <Icon
                  name={peer.kind === 'phone' || peer.kind === 'tablet' ? 'phone' : 'device'}
                  size={16}
                />
              </span>
              <span className="peer__body">
                <span className="peer__name">{peer.name}</span>
                <PathCost kind={peer.path.kind} away={!peer.present} />
              </span>
              <button
                type="button"
                className="button button--icon"
                onClick={() => session.disconnectPeer(peer.id)}
                aria-label={`Disconnect ${peer.name}`}
                title="Disconnect"
              >
                <Icon name="x" size={15} />
              </button>
            </li>
          ))}
        </ul>

        {/* Trystero re-announces every few seconds, so a device that is merely
            out of range comes back on its own. This is for the case it cannot
            fix: a phone whose tab was frozen — by the file picker, or by the
            screen locking — and whose sockets never woke with it. */}
        {state.peers.some(peer => !peer.present) && (
          <button
            type="button"
            className="popover__action"
            onClick={() => void session.reconnect()}
            disabled={state.busy}
          >
            <Icon name="retry" size={14} />
            {state.busy ? 'Reconnecting…' : 'Reconnect now'}
          </button>
        )}
      </div>
    </>
  )
}
