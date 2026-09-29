import {useEffect, useRef, useState} from 'react'
import QRCode from 'qrcode'
import {LIMITS} from '../../lib/core/config.ts'
import type {PeerInfo, SessionSnapshot, SharedText} from '../../lib/session/SessionManager.ts'
import {isQueued, isTerminal} from '../../lib/transfer/states.ts'
import {asLink} from '../../lib/utils/text.ts'
import {session} from '../store.ts'
import {Icon, Spinner} from './common.tsx'
import {Route} from './Route.tsx'
import {IncomingDrop, SharedDrop, sameItems, type PathLookup} from './TransferItem.tsx'

/**
 * The whole app. A room is already open by the time this renders, so the first
 * thing on screen is the code to scan — nothing to read, nothing to click.
 */
export function RoomScreen({
  state,
  onOpenDevices
}: {
  state: SessionSnapshot
  onOpenDevices: () => void
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const incoming = state.incoming.filter(transfer => !isTerminal(transfer.state))
  // Grouped across finished files too: a batch that loses each file as it
  // completes cannot say "3 of 5 downloaded", which is the whole point of it.
  const groups = groupByBatch(state.incoming)
  const running = groups.filter(group => group.items.some(file => !isTerminal(file.state)))
  const settled = groups.filter(group => group.items.every(file => isTerminal(file.state)))
  const sharing = groupByBatch(state.shared)
  const paths = usePaths(state.peers)
  const hasContent = state.shared.length > 0 || state.incoming.length > 0
  // Counts both directions, because that is what cancelling all of them does.
  // Offered only past one: with a single transfer its own Cancel is right there,
  // and a second way to do the same thing is just something else to read.
  const active =
    incoming.length +
    state.shared.flatMap(file => file.transfers).filter(t => !isTerminal(t.state)).length
  // Offers you have not answered yet are not transfers you started, and each
  // already has its own Decline. With nothing else going on, "Cancel all" on
  // the receiving side read as a way to decline them all at once.
  const undecided = incoming.filter(t => t.state === 'WAITING_FOR_ACCEPT' && !isQueued(t)).length

  return (
    <div className="room">
      {/* Before anything else: where this file would go, and by which road. */}
      <Route state={state} onOpenDevices={onOpenDevices} />

      <JoinStatus state={state} />

      {/* Keyed on the peer count so arriving or losing a device remounts this
          with its fold state fresh, rather than an effect setting state in
          response to a prop change and costing a second render pass. */}
      <Pair key={state.peers.length} state={state} />

      <button
        type="button"
        className={`drop ${hasContent ? 'drop--compact' : ''}`}
        onClick={() => fileInput.current?.click()}
      >
        <Icon name="upload" size={hasContent ? 20 : 26} />
        {/* "Drop" means nothing on a touch screen, so the copy follows the
            input method rather than assuming a mouse. */}
        {/* Named for what pressing it does, rather than for the gesture the
            box used to imply. Dropping is not confined to this control — it
            works anywhere on the page — so the hint is where that belongs. */}
        <span className="drop__title">
          <span className="pointer-only">Choose files</span>
          <span className="touch-only">Send files</span>
        </span>
        {!hasContent && (
          <span className="drop__hint">
            <span className="pointer-only">or drop them anywhere · paste an image</span>
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

      <SendText />

      {state.texts.length > 0 && (
        <section className="list">
          <h2 className="list__title">
            Text
            <span className="list__count">{state.texts.length}</span>
          </h2>
          <ul className="list__items">
            {state.texts.map(note => (
              <SharedNote key={note.id} note={note} />
            ))}
          </ul>
        </section>
      )}

      {active > 1 && active > undecided && (
        <button type="button" className="cancel-all" onClick={() => session.cancelAll()}>
          <Icon name="x" size={14} />
          Cancel all {active} transfers
        </button>
      )}

      {/* Incoming first, then what you are sending, then history.
          A fixed order rather than one that follows activity: sections that
          reshuffle while you are reaching for a button are worse than a section
          in a slightly wrong place. Incoming leads because it is the only one
          waiting on a decision from you — a file you already shared has nothing
          left to ask. Before this, files someone sent you appeared below your
          own sharing list, so the newest thing on screen was the lowest. */}
      {incoming.length > 0 && (
        <section className="list">
          <h2 className="list__title">
            Incoming
            <span className="list__count">{incoming.length}</span>
          </h2>
          <ul className="list__items">
            {running.map(group => (
              <IncomingDrop key={group.key} files={group.items} paths={paths} />
            ))}
          </ul>
        </section>
      )}

      {state.shared.length > 0 && (
        <section className="list">
          <h2 className="list__title">
            Sharing
            <span className="list__count">{state.shared.length}</span>
          </h2>
          <ul className="list__items">
            {sharing.map(group => (
              <SharedDrop key={group.key} files={group.items} paths={paths} />
            ))}
          </ul>
        </section>
      )}

      {settled.length > 0 && (
        <section className="list">
          <h2 className="list__title">Received</h2>
          <ul className="list__items">
            {settled.map(group => (
              <IncomingDrop key={group.key} files={group.items} paths={paths} />
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
  // Starts folded on every mount, and the call site remounts this whenever the
  // peer count changes — so a device arriving re-folds it, because the reason
  // it was opened is spent.
  const [expanded, setExpanded] = useState(false)

  if (connected && !expanded) {
    return (
      <section className="pair pair--folded">
        <button type="button" className="pair__reveal" onClick={() => setExpanded(true)}>
          {/* Any of these can join: the code opens in a browser on anything. */}
          <span className="pair__kinds">
            <Icon name="device" size={15} />
            <Icon name="phone" size={15} />
            <Icon name="globe" size={15} />
          </span>
          Add another device
        </button>
        <Devices state={state} />
      </section>
    )
  }

  return (
    <section className="pair">
      {/* Two columns once there is width for them, stacked on a phone. The
          wrapper exists so pending-approval rows stay full width underneath
          rather than becoming a third column. */}
      <div className="pair__columns">
        {state.shareUrl ? <QrCode value={state.shareUrl} /> : <div className="qr qr--placeholder" />}
        <Code display={state.display} url={state.shareUrl} />
      </div>
      {connected && (
        <button type="button" className="pair__reveal" onClick={() => setExpanded(false)}>
          Done
        </button>
      )}
      <Devices state={state} />
    </section>
  )
}

/**
 * How each device is reachable, as one map that keeps its identity until a
 * device's entry actually changes.
 *
 * The roster entries themselves are stable objects, so comparing them item by
 * item is exact: a link flipping from direct to relay is a new entry, and a new
 * map. Rebuilding the map on every render instead handed every memoized row a
 * new prop several times a second, and re-rendered all of them.
 */
function usePaths(peers: PeerInfo[]): PathLookup {
  const cache = useRef<{peers: PeerInfo[]; paths: PathLookup} | null>(null)
  if (!cache.current || !sameItems(cache.current.peers, peers)) {
    cache.current = {peers, paths: new Map(peers.map(peer => [peer.id, peer.path]))}
  }
  return cache.current.paths
}

/**
 * Things dropped together, kept together — newest batch first.
 *
 * Grouping is the sender's `batchId` rather than arrival time, so a device that
 * joins an hour later still sees the same batches rather than one clump of
 * everything it was told about at once. Anything from a build that sends no
 * batchId simply stands alone.
 *
 * Both lists arrive oldest-first and are reversed by *group*, not by item: the
 * batch you just dropped belongs at the top, but the files inside it belong in
 * the order they were picked.
 */
function groupByBatch<T extends {id: string; batchId: string | null}>(
  items: T[]
): {key: string; items: T[]}[] {
  const groups: {key: string; items: T[]}[] = []
  const byBatch = new Map<string, {key: string; items: T[]}>()

  for (const item of items) {
    if (item.batchId === null) {
      groups.push({key: item.id, items: [item]})
      continue
    }
    const existing = byBatch.get(item.batchId)
    if (existing) {
      existing.items.push(item)
      continue
    }
    const group = {key: item.batchId, items: [item]}
    byBatch.set(item.batchId, group)
    groups.push(group)
  }
  return groups.reverse()
}

/**
 * A link or a note, which is often the thing you actually wanted to move.
 *
 * A textarea rather than an input, so a pasted paragraph is readable instead of
 * scrolling past sideways one line at a time. It starts one row tall — looking
 * like an input, which is what it is most of the time — grows with the content,
 * and stops at five rows and scrolls. Enter sends, shift-Enter breaks the line.
 */
function SendText() {
  const [text, setText] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  const ready = text.trim().length > 0

  // Height follows the content; the max-height in CSS is what caps it, so the
  // two cannot disagree about where scrolling starts.
  useEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  const send = () => {
    if (!ready) return
    session.sendText(text)
    setText('')
  }

  return (
    <form
      className="sendtext"
      onSubmit={event => {
        event.preventDefault()
        send()
      }}
    >
      <textarea
        ref={box}
        className="field__input sendtext__input"
        rows={1}
        value={text}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey) return
          event.preventDefault()
          send()
        }}
        placeholder="Send a link or note…"
        aria-label="Send a link or note to connected devices"
        maxLength={LIMITS.maxTextLength}
        autoComplete="off"
      />
      <button type="submit" className="button sendtext__send" disabled={!ready}>
        Send
      </button>
    </form>
  )
}

function SharedNote({note}: {note: SharedText}) {
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [clipped, setClipped] = useState(false)
  const body = useRef<HTMLParagraphElement>(null)
  const link = asLink(note.text)

  // Measured rather than guessed from the character count: whether three lines
  // is enough depends on the width and where the text happens to wrap. Skipped
  // while expanded, when nothing overflows by definition.
  useEffect(() => {
    const el = body.current
    if (!el || expanded) return
    setClipped(el.scrollHeight > el.clientHeight + 1)
  }, [note.text, expanded])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(note.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard can be blocked; the text stays selectable either way.
    }
  }

  return (
    // One row, not a card. A note is usually a link or a sentence, and the card
    // it used to get spent 66px on 20px of text: the sender had its own line
    // below, and three word-labelled buttons set the height. The sender now
    // prefixes the text the way it would in any message list, and the controls
    // are icons.
    <li className={`note ${expanded ? 'note--open' : ''}`}>
      <span className="note__from">{note.from ?? 'You'}</span>
      {/* Never dangerouslySetInnerHTML, and never a linkifier: only a message
          that is entirely one http(s) URL becomes clickable, so what is read
          and what is opened cannot differ. */}
      <p
        ref={body}
        className={`note__text ${expanded ? 'note__text--open' : 'note__text--clipped'}`}
      >
        {note.text}
      </p>
      {clipped && (
        <button type="button" className="note__more" onClick={() => setExpanded(v => !v)}>
          {expanded ? 'Less' : 'More'}
        </button>
      )}
      <span className="note__actions">
        {link && (
          <a
            className="button button--icon button--tiny"
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            title="Open link"
            aria-label={`Open ${link}`}
          >
            <Icon name="link" size={14} />
          </a>
        )}
        <button
          type="button"
          className="button button--icon button--tiny"
          onClick={() => void copy()}
          title={copied ? 'Copied' : 'Copy'}
          aria-label={copied ? 'Copied' : 'Copy text'}
        >
          {/* The label carried the confirmation before; with an icon the tick
              has to carry it, or a copy would look like nothing happened. */}
          <Icon name={copied ? 'check' : 'copy'} size={14} />
        </button>
        <button
          type="button"
          className="button button--icon button--tiny"
          onClick={() => session.dismissText(note.id)}
          title="Remove"
          aria-label="Remove"
        >
          <Icon name="x" size={14} />
        </button>
      </span>
    </li>
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
        // Auto-translate rewrites strings that look like words; a mangled code
        // silently will not pair.
        translate="no"
        onClick={() => void copy('code', display)}
        title="Copy code"
        /* `title` is a pointer affordance only. The accessible name keeps the
           visible code in it and says what pressing it does, which the code on
           its own never did. */
        aria-label={`Copy code ${display}`}
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
