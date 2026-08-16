import {useEffect, useRef, useState} from 'react'
import QRCode from 'qrcode'
import type {SessionSnapshot} from '../../lib/session/SessionManager.ts'
import {isTerminal} from '../../lib/transfer/states.ts'
import {session} from '../store.ts'
import {Icon, Spinner} from './common.tsx'
import {IncomingFile, SharedFile} from './TransferItem.tsx'

/**
 * The whole app. A room is already open by the time this renders, so the first
 * thing on screen is the code to scan — nothing to read, nothing to click.
 */
export function RoomScreen({state}: {state: SessionSnapshot}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const incoming = state.incoming.filter(transfer => !isTerminal(transfer.state))
  const finished = state.incoming.filter(transfer => isTerminal(transfer.state))
  const hasContent = state.shared.length > 0 || state.incoming.length > 0

  return (
    <div className="room">
      <JoinStatus state={state} />

      <Pair state={state} />

      <button
        type="button"
        className={`drop ${hasContent ? 'drop--compact' : ''}`}
        onClick={() => fileInput.current?.click()}
      >
        <Icon name="upload" size={hasContent ? 20 : 26} />
        {/* "Drop" means nothing on a touch screen, so the copy follows the
            input method rather than assuming a mouse. */}
        <span className="drop__title">
          <span className="pointer-only">Drop files anywhere</span>
          <span className="touch-only">Send files</span>
        </span>
        {!hasContent && (
          <span className="drop__hint">
            <span className="pointer-only">or click to choose · paste an image</span>
            <span className="touch-only">Photos, videos, documents — anything</span>
          </span>
        )}
      </button>
      <input
        ref={fileInput}
        type="file"
        multiple
        // Every type is accepted, but saying so explicitly matters on Android:
        // an input with no accept at all makes Chrome offer the camera and
        // sound recorder as sources, and it asks for those permissions before
        // the chooser even opens. Nothing here ever touches a microphone.
        accept="*/*"
        hidden
        onChange={event => {
          if (event.target.files) session.shareFiles([...event.target.files])
          event.target.value = ''
        }}
      />

      {state.shared.length > 0 && (
        <section className="list">
          <h2 className="list__title">
            Sharing
            <span className="list__count">{state.shared.length}</span>
          </h2>
          <ul className="list__items">
            {state.shared.map(file => (
              <SharedFile key={file.id} file={file} />
            ))}
          </ul>
        </section>
      )}

      {incoming.length > 0 && (
        <section className="list">
          <h2 className="list__title">
            Incoming
            <span className="list__count">{incoming.length}</span>
          </h2>
          <ul className="list__items">
            {incoming.map(transfer => (
              <IncomingFile key={transfer.id} transfer={transfer} />
            ))}
          </ul>
        </section>
      )}

      {finished.length > 0 && (
        <section className="list">
          <h2 className="list__title">Received</h2>
          <ul className="list__items">
            {finished.map(transfer => (
              <IncomingFile key={transfer.id} transfer={transfer} />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/**
 * The code, and how much room it deserves.
 *
 * Up until the first device connects this is the entire point of the screen, so
 * it gets the space. After that the job has changed to sending files, and a
 * full-size QR just pushes the drop target down — most of a phone screen spent
 * on something already done. It folds into one row instead of disappearing: a
 * room holds several devices, and the code is the only way to let the next one
 * in — hiding it outright would mean disconnecting everything to add a laptop.
 *
 * Pending approvals are deliberately outside the fold — those must stay
 * impossible to miss.
 */
function Pair({state}: {state: SessionSnapshot}) {
  const connected = state.peers.length > 0
  const [expanded, setExpanded] = useState(false)

  // Re-fold once a device actually arrives: the reason it was opened is spent.
  useEffect(() => setExpanded(false), [state.peers.length])

  if (connected && !expanded) {
    return (
      <section className="pair pair--folded">
        <button type="button" className="pair__reveal" onClick={() => setExpanded(true)}>
          <Icon name="device" size={15} />
          Add another device
        </button>
        <Devices state={state} />
      </section>
    )
  }

  return (
    <section className="pair">
      {state.shareUrl ? <QrCode value={state.shareUrl} /> : <div className="qr qr--placeholder" />}
      <Code display={state.display} url={state.shareUrl} />
      {connected && (
        <button type="button" className="pair__reveal" onClick={() => setExpanded(false)}>
          Done
        </button>
      )}
      <Devices state={state} />
    </section>
  )
}

/** How long to look before admitting nobody else is on that code. */
const LOOKUP_MS = 12_000

/**
 * There is no server holding a registry of rooms, so an unknown code cannot be
 * rejected — subscribing to it simply produces an empty room. That is fine, but
 * it must not look like a successful join, so say what actually happened.
 */
function JoinStatus({state}: {state: SessionSnapshot}) {
  const [gaveUp, setGaveUp] = useState(false)

  useEffect(() => {
    setGaveUp(false)
    const timer = setTimeout(() => setGaveUp(true), LOOKUP_MS)
    return () => clearTimeout(timer)
  }, [state.code])

  const searching = state.role === 'guest' && !state.everHadPeer && state.peers.length === 0
  if (!searching) return null

  if (!gaveUp) {
    return (
      <div className="banner banner--warn">
        <Spinner />
        <div>
          <strong>Looking for other devices…</strong>
        </div>
      </div>
    )
  }

  // Plain language only. Why an unknown code still opens a room is explained in
  // About, not in the message someone reads while wondering what went wrong.
  return (
    <div className="banner banner--warn">
      <Icon name="alert" />
      <div>
        <strong>No one's here yet</strong>
        <span>Double-check the code, or share the one below instead.</span>
      </div>
    </div>
  )
}

/**
 * Only devices waiting to be let in. Connected ones live behind the count
 * button — but an approval request has to be impossible to miss.
 */
function Devices({state}: {state: SessionSnapshot}) {
  if (state.pending.length === 0) return null

  return (
    <div className="devices">
      {state.pending.map(peer => (
        <span key={peer.id} className="device device--pending">
          <Icon name="phone" size={14} />
          {peer.name} wants to join
          <button type="button" className="device__act" onClick={() => session.approvePeer(peer.id)}>
            Allow
          </button>
          <button type="button" className="device__act" onClick={() => session.blockPeer(peer.id)}>
            Block
          </button>
        </span>
      ))}
    </div>
  )
}

function QrCode({value, size = 208}: {value: string; size?: number}) {
  const [svg, setSvg] = useState('')

  useEffect(() => {
    let cancelled = false
    // Always dark-on-white regardless of theme: that is what camera apps read.
    QRCode.toString(value, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      width: size,
      color: {dark: '#0b0d10', light: '#ffffff'}
    })
      .then(result => {
        if (!cancelled) setSvg(result)
      })
      .catch(() => setSvg(''))
    return () => {
      cancelled = true
    }
  }, [value, size])

  if (!svg) return <div className="qr qr--placeholder" />
  return (
    <div className="qr" role="img" aria-label="Scan to connect" dangerouslySetInnerHTML={{__html: svg}} />
  )
}

function Code({display, url}: {display: string | null; url: string | null}) {
  const [copied, setCopied] = useState<'code' | 'link' | null>(null)

  const copy = async (kind: 'code' | 'link', text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(kind)
      setTimeout(() => setCopied(null), 1800)
    } catch {
      // Clipboard can be blocked; the code stays visible for manual entry.
    }
  }

  if (!display) return null
  return (
    <div className="code">
      <button
        type="button"
        className="code__value"
        onClick={() => void copy('code', display)}
        title="Copy code"
      >
        {display}
      </button>
      {url && (
        <button type="button" className="code__link" onClick={() => void copy('link', url)}>
          <Icon name="link" size={14} />
          {copied === 'link' ? 'Link copied' : copied === 'code' ? 'Code copied' : 'Copy link'}
        </button>
      )}
    </div>
  )
}
