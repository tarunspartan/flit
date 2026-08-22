import {useEffect, useRef, useState} from 'react'
import QRCode from 'qrcode'
import {LIMITS} from '../../lib/core/config.ts'
import type {SessionSnapshot, SharedText} from '../../lib/session/SessionManager.ts'
import type {SharedFileView, TransferView} from '../../lib/transfer/states.ts'
import {isTerminal} from '../../lib/transfer/states.ts'
import {asLink} from '../../lib/utils/text.ts'
import {formatBytes} from '../../lib/utils/format.ts'
import {session} from '../store.ts'
import {Icon, PathCost, ProgressBar, Spinner} from './common.tsx'
import {Route} from './Route.tsx'
import {IncomingFile, IncomingRow, SharedFile, SharedRow, type PathLookup} from './TransferItem.tsx'

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
  // Rebuilt each render on purpose: the path is what changes, and a memo keyed
  // on the peer list would miss a link flipping from direct to relay.
  const paths: PathLookup = new Map(state.peers.map(peer => [peer.id, peer.path]))
  const hasContent = state.shared.length > 0 || state.incoming.length > 0
  // Counts both directions, because that is what cancelling all of them does.
  // Offered only past one: with a single transfer its own Cancel is right there,
  // and a second way to do the same thing is just something else to read.
  const active =
    incoming.length +
    state.shared.flatMap(file => file.transfers).filter(t => !isTerminal(t.state)).length

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

      {active > 1 && (
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
            {running.map(group =>
              group.items.length > 1 ? (
                <IncomingBatch key={group.key} files={group.items} paths={paths} />
              ) : (
                <IncomingFile
                  key={group.key}
                  transfer={group.items[0]!}
                  path={paths.get(group.items[0]!.peerId)}
                />
              )
            )}
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
            {sharing.map(group =>
              group.items.length > 1 ? (
                <SharedBatch key={group.key} files={group.items} paths={paths} />
              ) : (
                <SharedFile key={group.key} file={group.items[0]!} paths={paths} />
              )
            )}
          </ul>
        </section>
      )}

      {settled.length > 0 && (
        <section className="list">
          <h2 className="list__title">Received</h2>
          <ul className="list__items">
            {settled.map(group =>
              group.items.length > 1 ? (
                <IncomingBatch key={group.key} files={group.items} paths={paths} />
              ) : (
                <IncomingFile
                  key={group.key}
                  transfer={group.items[0]!}
                  path={paths.get(group.items[0]!.peerId)}
                />
              )
            )}
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
          <Icon name="device" size={15} />
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
 * Show / Hide, on the same line as everything else it belongs to.
 *
 * The count is on the button rather than in the summary because that is the
 * question it answers — how much is behind this — and it keeps the summary to
 * the facts about the drop itself.
 */
function BatchToggle({open, count, onToggle}: {open: boolean; count: number; onToggle: () => void}) {
  return (
    <button
      type="button"
      className={`batch__toggle ${open ? 'is-open' : ''}`}
      onClick={onToggle}
      aria-expanded={open}
    >
      {open ? 'Hide' : `Show ${count}`}
      <Icon name="chevron" size={14} />
    </button>
  )
}

/**
 * How far along a whole batch is, drawn on the card's bottom edge.
 *
 * Deliberately not inside the summary row: a bar that appears between the title
 * and the buttons the moment a transfer starts makes the row taller and drags
 * the controls out of line with the name they belong to. On the edge it costs
 * three pixels and never moves anything.
 */
function BatchRail({done, total}: {done: number; total: number}) {
  return (
    <span className="batch__rail">
      <ProgressBar value={total === 0 ? 0 : done / total} state={done === total ? 'done' : 'active'} />
    </span>
  )
}

/**
 * One drop you are sending, folded into a single row.
 *
 * Five files dropped at once used to be five cards, each with a line per device
 * — a screen of scrolling for one action. The summary carries what there is to
 * know before opening it: how many, how big, how many have landed.
 */
function SharedBatch({files, paths}: {files: SharedFileView[]; paths: PathLookup}) {
  const [open, setOpen] = useState(false)
  const bytes = files.reduce((total, file) => total + file.size, 0)
  // Sent means every device that was offered it has it. With no device in the
  // room there is nothing to be done yet, so nothing counts as done.
  const done = files.filter(
    file =>
      file.transfers.length > 0 &&
      file.transfers.every(transfer => transfer.state === 'COMPLETED')
  ).length
  const started = files.some(file =>
    file.transfers.some(transfer => transfer.state !== 'WAITING_FOR_ACCEPT')
  )
  const idle = files.every(file => file.transfers.length === 0)
  // A batch goes to every device in the room, and they need not be reachable
  // the same way. One label is only honest when they all agree; when they do
  // not, the per-device breakdown on each file is the answer, not an average.
  const kinds = new Set(
    files.flatMap(file => file.transfers.map(transfer => paths.get(transfer.peerId)?.kind))
  )
  const sharedKind = kinds.size === 1 ? [...kinds][0] : undefined

  return (
    <li className="batch">
      <div className="batch__head">
        <span className="batch__icon" aria-hidden="true">
          <Icon name="upload" size={16} />
        </span>
        <div className="batch__ident">
          <span className="batch__name">{files.length} files</span>
          <span className="batch__meta">
            <span className="meta__field">{formatBytes(bytes)}</span>
            {/* No separator before the badge: a pill is already visually
                self-contained, and a dot beside it reads as a stray mark. */}
            {sharedKind && <PathCost kind={sharedKind} />}
            <span className="dot">·</span>
            {idle ? (
              <span className="meta__field">waiting for a device</span>
            ) : (
              <span className="batch__done">
                {done} of {files.length} sent
              </span>
            )}
          </span>
        </div>
        <button
          type="button"
          className="button button--icon button--tiny"
          onClick={() => files.forEach(file => session.unshare(file.id))}
          aria-label={`Stop sharing all ${files.length} files`}
          title="Stop sharing all"
        >
          <Icon name="x" size={15} />
        </button>
        <BatchToggle open={open} count={files.length} onToggle={() => setOpen(value => !value)} />
      </div>

      {started && <BatchRail done={done} total={files.length} />}

      {open && (
        <ul className="batch__items">
          {files.map(file => (
            <SharedRow key={file.id} file={file} paths={paths} />
          ))}
        </ul>
      )}
    </li>
  )
}

/**
 * One drop arriving, folded into a single row until asked to open.
 *
 * Five files arriving as five full cards pushes everything else off the screen
 * before you have decided anything. The summary carries what the decision needs
 * — how many, how big, who from — and Download all is the usual answer.
 */
function IncomingBatch({files, paths}: {files: TransferView[]; paths: PathLookup}) {
  const [open, setOpen] = useState(false)
  const bytes = files.reduce((total, file) => total + file.size, 0)
  const done = files.filter(file => file.state === 'COMPLETED').length
  const started = done > 0 || files.some(file => file.state !== 'WAITING_FOR_ACCEPT')
  // Only the ones still waiting on a decision; already queued or running files
  // must not be re-accepted.
  const undecided = files.filter(
    file => file.state === 'WAITING_FOR_ACCEPT' && file.queuePosition === null
  )
  const batchKind = files[0] ? paths.get(files[0].peerId)?.kind : undefined

  return (
    <li className="batch">
      <div className={`batch__head ${undecided.length > 0 ? 'batch__head--stacked' : ''}`}>
        <span className="batch__icon batch__icon--in" aria-hidden="true">
          <Icon name="download" size={16} />
        </span>
        <div className="batch__ident">
          <span className="batch__name">{files.length} files</span>
          <span className="batch__meta">
            <span className="meta__field">{formatBytes(bytes)}</span>
            <span className="dot">·</span>
            <span className="meta__field">from {files[0]?.peerName}</span>
            {/* Every file in a batch comes from one device, so one label is the
                whole truth about what this batch costs. */}
            {/* No separator before the badge: a pill is already visually
                self-contained, and a dot beside it reads as a stray mark. */}
            {batchKind && <PathCost kind={batchKind} />}
            {started && (
              <>
                <span className="dot">·</span>
                <span className="batch__done">
                  {done} of {files.length} downloaded
                </span>
              </>
            )}
          </span>
        </div>
        {undecided.length > 0 && (
          <button
            type="button"
            className="button button--primary button--small"
            onClick={() => undecided.forEach(file => session.accept(file.id))}
          >
            <Icon name="download" size={14} /> Download all
          </button>
        )}
        <BatchToggle open={open} count={files.length} onToggle={() => setOpen(value => !value)} />
      </div>

      {started && <BatchRail done={done} total={files.length} />}

      {open && (
        <ul className="batch__items">
          {files.map(file => (
            <IncomingRow key={file.id} transfer={file} path={paths.get(file.peerId)} />
          ))}
        </ul>
      )}
    </li>
  )
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
