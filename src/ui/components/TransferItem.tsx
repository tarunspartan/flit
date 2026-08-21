import {useState, type ReactNode} from 'react'
import type {NetworkPath} from '../../lib/transport/Transport.ts'
import type {SharedFileView, TransferView} from '../../lib/transfer/states.ts'
import {isMoving, isQueued, isTerminal} from '../../lib/transfer/states.ts'
import {formatBytes, formatDuration, formatPercent, formatSpeed} from '../../lib/utils/format.ts'
import {session} from '../store.ts'
import {Icon, PathCost, ProgressBar, type IconName} from './common.tsx'

type Tone = 'quiet' | 'ok' | 'warn' | 'bad'

/**
 * Every state's word and colour, in one table.
 *
 * The word differs by direction because the same state means different things
 * at each end — "Sending" is what the device holding the file is doing, not
 * what you are doing while receiving it. The tone is here rather than in CSS so
 * a state cannot be amber in one component and red in another, which is what
 * happened to RECONNECTING: its progress bar was amber and its label red.
 */
const STATE: Record<TransferView['state'], {send: string; receive: string; tone: Tone}> = {
  QUEUED: {send: 'Queued', receive: 'Queued', tone: 'quiet'},
  WAITING_FOR_ACCEPT: {send: 'Waiting', receive: 'Waiting', tone: 'quiet'},
  TRANSFERRING: {send: 'Sending', receive: 'Receiving', tone: 'quiet'},
  PAUSED: {send: 'Paused', receive: 'Paused', tone: 'warn'},
  RECONNECTING: {send: 'Reconnecting', receive: 'Reconnecting', tone: 'warn'},
  VERIFYING: {send: 'Verifying', receive: 'Verifying', tone: 'quiet'},
  COMPLETED: {send: 'Sent', receive: 'Done', tone: 'ok'},
  // A decision, not a fault: neither of these is coloured like a failure.
  REJECTED: {send: 'Declined', receive: 'Declined', tone: 'quiet'},
  CANCELLED: {send: 'Cancelled', receive: 'Cancelled', tone: 'quiet'},
  FAILED: {send: 'Failed', receive: 'Failed', tone: 'bad'}
}

const label = (transfer: TransferView, to: 'send' | 'receive'): string =>
  isQueued(transfer) ? 'Queued' : STATE[transfer.state][to]

const tone = (transfer: TransferView): Tone =>
  isQueued(transfer) ? 'quiet' : STATE[transfer.state].tone

/**
 * Outcomes whose message only restates the label above it.
 *
 * "Cancelled", then "Transfer cancelled", then "This transfer was cancelled" is
 * one fact printed three times. Worse for a decline: the message reads "The
 * other device declined this file", which on the device that did the declining
 * is simply untrue. Everything else — a stall, a lost connection, a failed
 * integrity check — says something the label cannot, and is kept.
 */
const SELF_EVIDENT: ReadonlySet<string> = new Set(['transfer-cancelled', 'transfer-rejected'])

/**
 * How each peer is currently reachable, keyed by peer id.
 *
 * Passed down rather than read from the store, so a path flipping from direct
 * to relay re-renders the rows that show it — the snapshot is what drives the
 * tree, and a component reaching around it would keep a stale label.
 */
export type PathLookup = ReadonlyMap<string, NetworkPath>

/** What a receiver may do with a transfer, and what to call it. */
interface Action {
  key: string
  icon: IconName
  label: string
  /** How prominent it is. The row and the card style these differently. */
  tone: 'primary' | 'ghost' | 'normal'
  run: () => void
}

/**
 * The rules for what a receiver can do, in one place.
 *
 * A file appears as a full card on its own and as a line inside a batch, and
 * the two used to carry their own copy of this. Two copies of a state machine
 * drift: a state handled in one and forgotten in the other is a button that
 * exists in the list view and not in the card. The rules live here; the two
 * components only decide how to draw them.
 */
function actionsFor(transfer: TransferView): Action[] {
  const {id, state} = transfer
  const queued = isQueued(transfer)
  const actions: Action[] = []

  if (state === 'WAITING_FOR_ACCEPT' && !queued) {
    // Accepting *is* the download, so the button says what it does.
    actions.push({key: 'accept', icon: 'download', label: 'Download', tone: 'primary', run: () => session.accept(id)})
  }
  if (state === 'TRANSFERRING') {
    actions.push({key: 'pause', icon: 'pause', label: 'Pause', tone: 'normal', run: () => session.pause(id)})
  }
  if (state === 'PAUSED') {
    actions.push({key: 'resume', icon: 'play', label: 'Resume', tone: 'normal', run: () => session.resume(id)})
  }
  if (transfer.canRetry) {
    actions.push({key: 'retry', icon: 'retry', label: 'Retry', tone: 'normal', run: () => session.retry(id)})
  }
  if (transfer.downloadReady && state === 'COMPLETED') {
    actions.push({key: 'save', icon: 'save', label: 'Save again', tone: 'normal', run: () => session.saveAgain(id)})
  }

  // Backing out, which is three different things wearing one icon. Leaving the
  // queue is not a cancel: cancelling is terminal and a queued file has not
  // started, so "Not now" has to put the Download button back.
  if (queued) {
    actions.push({key: 'unqueue', icon: 'x', label: 'Not now', tone: 'normal', run: () => session.unqueue(id)})
  } else if (state === 'WAITING_FOR_ACCEPT') {
    actions.push({key: 'decline', icon: 'x', label: 'Decline', tone: 'ghost', run: () => session.reject(id)})
  } else if (transfer.canCancel) {
    actions.push({key: 'cancel', icon: 'x', label: 'Cancel', tone: 'normal', run: () => session.cancel(id)})
  }
  return actions
}

/**
 * Which way the bytes are going, for the one line that does not otherwise say.
 *
 * A card carries direction twice over — an upload glyph and "Sending", a
 * download glyph and "Receiving". A row has neither: no icon, and while it is
 * moving the state is replaced by a bare percentage, so a file going out and a
 * file coming in render identically next to identical bars. This is the
 * smallest mark that separates them.
 */
function Way({sending}: {sending: boolean}) {
  return <Icon name={sending ? 'upload' : 'download'} size={12} />
}

/* ------------------------------------------------------------------- cards */

/** One dropped file, with a line per device it is going to. */
export function SharedFile({file, paths}: {file: SharedFileView; paths: PathLookup}) {
  const done = file.transfers.filter(transfer => transfer.state === 'COMPLETED').length

  return (
    <li className="shared">
      <div className="shared__head">
        <span className="shared__icon" aria-hidden="true">
          <Icon name="upload" size={17} />
        </span>
        <div className="shared__ident">
          <span className="shared__name" title={file.name}>
            {file.name}
          </span>
          <span className="shared__meta">
            {formatBytes(file.size)}
            {file.transfers.length > 0 && (
              <>
                <span className="dot">·</span>
                {done} of {file.transfers.length} device{file.transfers.length === 1 ? '' : 's'}
              </>
            )}
          </span>
        </div>
        <button
          type="button"
          className="button button--icon"
          onClick={() => session.unshare(file.id)}
          aria-label={`Stop sharing ${file.name}`}
          title="Stop sharing"
        >
          <Icon name="x" size={16} />
        </button>
      </div>

      <SharedBody file={file} paths={paths} />
    </li>
  )
}

/**
 * Who this file is going to and how each of them is doing.
 *
 * Shared by the card and the batch row for the same reason the receiving side
 * shares one body: a file offered as part of a batch is not a lesser file, and
 * its per-device progress should not depend on how it was dropped.
 */
function SharedBody({file, paths}: {file: SharedFileView; paths: PathLookup}) {
  if (file.transfers.length === 0) {
    return (
      <p className="shared__waiting">
        Waiting for a device to join — it will be offered this file automatically.
      </p>
    )
  }
  return (
    <ul className="peerlines">
      {file.transfers.map(transfer => (
        <PeerLine key={transfer.id} transfer={transfer} path={paths.get(transfer.peerId)} />
      ))}
    </ul>
  )
}

/** How one device is doing with the file above it, and over what. */
function PeerLine({transfer, path}: {transfer: TransferView; path: NetworkPath | undefined}) {
  const {state} = transfer

  return (
    <li className="row row--peer">
      <span className="row__name">{transfer.peerName}</span>
      {/* Per device, not per file: a laptop on the same Wi-Fi and a phone on
          mobile data are the same file costing two very different things. */}
      {path && !isTerminal(state) && <PathCost kind={path.kind} />}

      {isMoving(state) && (
        <span className="row__bar">
          <ProgressBar value={transfer.progress} state={state === 'RECONNECTING' ? 'error' : 'active'} />
        </span>
      )}

      <span
        className={`row__state state--${tone(transfer)}`}
        title={state === 'TRANSFERRING' ? 'Sending' : undefined}
        aria-label={
          state === 'TRANSFERRING'
            ? `Sending, ${formatPercent(transfer.progress)}, ${formatSpeed(transfer.speed)}`
            : undefined
        }
      >
        {state === 'COMPLETED' && <Icon name="check" size={14} />}
        {state === 'TRANSFERRING' && <Way sending />}
        {state === 'TRANSFERRING'
          ? `${formatPercent(transfer.progress)} · ${formatSpeed(transfer.speed)}`
          : label(transfer, 'send')}
      </span>

      <RowActions transfer={transfer} sending />
    </li>
  )
}

/** A file another device is offering to this one. */
export function IncomingFile({transfer, path}: {transfer: TransferView; path: NetworkPath | undefined}) {
  const {state} = transfer
  const queued = isQueued(transfer)

  return (
    // A queued card is WAITING_FOR_ACCEPT on the wire but not in the UI — the
    // decision has been made and it is waiting its turn. Naming it for what it
    // is keeps the "needs you" styling off it: the accent ring, and the mobile
    // rule that stretches an awaiting card's buttons to full thumb width, which
    // blew "Not now" up to 182px and wrapped the sentence beside it.
    <li className={`incoming incoming--${queued ? 'queued' : state.toLowerCase()}`}>
      <div className="incoming__head">
        <span className="incoming__icon" aria-hidden="true">
          <Icon name="download" size={17} />
        </span>
        <div className="incoming__ident">
          <span className="incoming__name" title={transfer.name}>
            {transfer.name}
          </span>
          {/* Every field is its own element, and the separators are siblings
              between them. A bare text node would merge with its neighbour on
              narrow screens, where the dots give way to spacing. */}
          <span className="incoming__meta">
            <span className="meta__field">{formatBytes(transfer.size)}</span>
            <span className="dot">·</span>
            <span className="meta__field">from {transfer.peerName}</span>
            {/* No separator before the badge: a pill is already visually
                self-contained, and a dot beside it reads as a stray mark. */}
            {path && <PathCost kind={path.kind} />}
          </span>
        </div>
        {/* An undecided file has no chip: its Download button is its state, and
            a "Waiting" label beside a button that says what to do is noise. */}
        {(queued || state !== 'WAITING_FOR_ACCEPT') && (
          <span className={`incoming__state state--${tone(transfer)}`}>
            {state === 'COMPLETED' && <Icon name="check" size={15} />}
            {state === 'FAILED' && <Icon name="alert" size={15} />}
            {label(transfer, 'receive')}
          </span>
        )}
      </div>

      <IncomingBody transfer={transfer} path={path} />
    </li>
  )
}

/**
 * Everything about a transfer below its name: storage advice, live progress
 * with speed and bytes, the outcome, errors, controls, and the details table.
 *
 * Deliberately shared by the card and the batch row. Batching is only about
 * *offering* several files in one go — it is not a reduced-feature mode, and a
 * file that happened to arrive in a batch had lost its speed, its byte counts
 * and its details table purely because of where it was drawn. One body means
 * the two densities cannot drift apart again.
 */
function IncomingBody({transfer, path}: {transfer: TransferView; path?: NetworkPath}) {
  const [expanded, setExpanded] = useState(false)
  const {state} = transfer
  // Anything that ran has numbers worth keeping, whether it finished or not.
  // Details used to vanish the moment a transfer failed, which is exactly when
  // "how far did it get" is the question being asked.
  const ran = isMoving(state) || transfer.startedAt !== null

  return (
    <>
      {transfer.storageWarning && <Note tone="warn">{transfer.storageWarning}</Note>}

      {isMoving(state) && (
        <div className="progressblock">
          <ProgressBar
            value={transfer.progress}
            state={state === 'RECONNECTING' ? 'error' : 'active'}
          />
          <Stats transfer={transfer} />
        </div>
      )}

      <Outcome transfer={transfer} />
      <CardActions transfer={transfer} />

      {ran && (
        <>
          <button
            type="button"
            className={`details-toggle ${expanded ? 'is-open' : ''}`}
            onClick={() => setExpanded(value => !value)}
            aria-expanded={expanded}
          >
            <Icon name="chevron" size={15} />
            Details
          </button>
          {expanded && <Details transfer={transfer} path={path} />}
        </>
      )}
    </>
  )
}

/**
 * The same four facts in the same order, every time: how far, how much, how
 * fast, how long left.
 *
 * States that cannot answer one simply leave it out. They used to substitute a
 * sentence instead — "Verifying…" under a chip already reading "Verifying",
 * and "Reconnecting — resumes from 1.2 GB" under one reading "Reconnecting",
 * on a line that already said "1.2 GB / 3.02 GB". Both were the same fact
 * twice; the chip above is where the state is named.
 */
function Stats({transfer}: {transfer: TransferView}) {
  const running = transfer.state === 'TRANSFERRING'
  return (
    <div className="stats">
      <span className="stats__percent">{formatPercent(transfer.progress)}</span>
      <span className="dot">·</span>
      <span>
        {formatBytes(transfer.bytesTransferred)} / {formatBytes(transfer.size)}
      </span>
      {running && (
        <>
          <span className="dot">·</span>
          <span className="stats__speed">{formatSpeed(transfer.speed)}</span>
          <span className="dot">·</span>
          <span>
            {transfer.etaSeconds === null
              ? 'estimating…'
              : `~${formatDuration(transfer.etaSeconds)} left`}
          </span>
        </>
      )}
    </div>
  )
}

/** One line of consequence, in the colour of what it means. */
function Note({tone, children}: {tone: 'ok' | 'warn' | 'bad'; children: ReactNode}) {
  return (
    <p className={`note-line note-line--${tone}`}>
      <Icon name={tone === 'ok' ? 'shield' : 'alert'} size={15} />
      <span>{children}</span>
    </p>
  )
}

/**
 * What became of it — said once, or not at all.
 *
 * The chip beside the filename is the headline. A message earns its own line
 * only by adding something the headline does not already carry.
 */
function Outcome({transfer}: {transfer: TransferView}) {
  const {state, error} = transfer

  if (state === 'COMPLETED') {
    return (
      <Note tone="ok">
        {transfer.verified ? 'Verified. ' : ''}
        {transfer.savedToDisk ? 'Saved where you chose.' : 'Saved to your downloads.'}
      </Note>
    )
  }

  if (!error || !isTerminal(state) || SELF_EVIDENT.has(error.code)) return null
  return <Note tone="bad">{error.message}</Note>
}

/** The card's controls: full-size, labelled, one per rule. */
function CardActions({transfer}: {transfer: TransferView}) {
  const actions = actionsFor(transfer)
  if (actions.length === 0) return null

  return (
    <div className="incoming__actions">
      {/* "the current one" rather than "the current download": measured at 251px
          against a 230px budget on a 393px phone, it wrapped to two lines. This
          is 216px. */}
      {isQueued(transfer) && (
        <span className="incoming__queued">Starts when the current one finishes.</span>
      )}
      {actions.map(action =>
        action.tone === 'ghost' ? (
          <button key={action.key} type="button" className="button button--ghost" onClick={action.run}>
            {action.label}
          </button>
        ) : (
          <button
            key={action.key}
            type="button"
            className={`button ${action.tone === 'primary' ? 'button--primary' : 'button--small'}`}
            onClick={action.run}
          >
            <Icon name={action.icon} size={action.tone === 'primary' ? 16 : 14} /> {action.label}
          </button>
        )
      )}
    </div>
  )
}

/* -------------------------------------------------------------------- rows */

/**
 * One file inside a batch, on a single line.
 *
 * The full card carries progress numbers, storage advice and a details table.
 * Five of those stacked is exactly the wall batching exists to avoid, so an
 * opened batch gets rows instead: what you need at a glance, plus whatever you
 * might actually act on. A file shared on its own still gets the card.
 */
export function IncomingRow({transfer, path}: {transfer: TransferView; path?: NetworkPath}) {
  const [open, setOpen] = useState(false)
  const {state} = transfer
  const queued = isQueued(transfer)
  const offered = state === 'WAITING_FOR_ACCEPT' && !queued

  return (
    <li className={`row ${open ? 'row--open' : ''}`}>
      <span className="row__name" title={transfer.name}>
        {transfer.name}
      </span>
      <span className="row__size">{formatBytes(transfer.size)}</span>

      {isMoving(state) && (
        <span className="row__bar">
          <ProgressBar value={transfer.progress} state={state === 'RECONNECTING' ? 'error' : 'active'} />
        </span>
      )}

      {/* An undecided file shows its Download button where the state would be —
          the button is the state. */}
      {!offered && (
        <span
          className={`row__state state--${tone(transfer)}`}
          title={state === 'TRANSFERRING' ? 'Receiving' : undefined}
          aria-label={
            state === 'TRANSFERRING'
              ? `Receiving, ${formatPercent(transfer.progress)}`
              : undefined
          }
        >
          {state === 'COMPLETED' && <Icon name="check" size={13} />}
          {state === 'TRANSFERRING' && <Way sending={false} />}
          {state === 'TRANSFERRING' ? formatPercent(transfer.progress) : label(transfer, 'receive')}
        </span>
      )}

      {/* Compact controls only while closed. Opened, the body below carries the
          same actions at full size, and showing both would be two ways to press
          the same button. */}
      {!open && <RowActions transfer={transfer} />}

      <button
        type="button"
        className={`row__toggle ${open ? 'is-open' : ''}`}
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        aria-label={`${open ? 'Hide' : 'Show'} details for ${transfer.name}`}
        title={open ? 'Hide details' : 'Details'}
      >
        <Icon name="chevron" size={14} />
      </button>

      {!open && transfer.storageWarning && (
        <p className="row__warning">
          <Icon name="alert" size={13} />
          {transfer.storageWarning}
        </p>
      )}

      {open && (
        <div className="row__body">
          <IncomingBody transfer={transfer} path={path} />
        </div>
      )}
    </li>
  )
}

/**
 * A row's controls: the primary one keeps its label because it is the whole
 * point of the row, the rest shrink to icons so the controls cost a line's
 * height and no more.
 *
 * `sending` narrows the rules to the ones that make sense for a file leaving
 * this device — there is nothing to accept or decline about your own file.
 */
function RowActions({transfer, sending = false}: {transfer: TransferView; sending?: boolean}) {
  const actions = actionsFor(transfer).filter(
    action => !sending || !['accept', 'decline', 'unqueue', 'cancel'].includes(action.key)
  )
  if (actions.length === 0) return <span className="row__pad" />

  return (
    <span className="row__acts">
      {actions.map(action =>
        action.tone === 'primary' ? (
          <button
            key={action.key}
            type="button"
            className="button button--primary button--small"
            onClick={action.run}
          >
            {action.label}
          </button>
        ) : (
          <button
            key={action.key}
            type="button"
            className="button button--icon button--tiny"
            onClick={action.run}
            aria-label={`${action.label} ${transfer.name}`}
            title={action.label}
          >
            <Icon name={action.icon} size={14} />
          </button>
        )
      )}
    </span>
  )
}

/**
 * One file you are sending, on a single line.
 *
 * A room holds several devices, so a file is several transfers. The row shows
 * their average rather than one line each — the per-device breakdown is worth a
 * card, and a card is what a file shared on its own gets.
 */
export function SharedRow({file, paths}: {file: SharedFileView; paths: PathLookup}) {
  const [open, setOpen] = useState(false)
  const total = file.transfers.length
  const sent = file.transfers.filter(transfer => transfer.state === 'COMPLETED').length
  const running = file.transfers.some(transfer => !isTerminal(transfer.state))
  const started = file.transfers.some(transfer => transfer.state !== 'WAITING_FOR_ACCEPT')
  const progress = total === 0 ? 0 : file.transfers.reduce((sum, t) => sum + t.progress, 0) / total

  return (
    <li className={`row ${open ? 'row--open' : ''}`}>
      <span className="row__name" title={file.name}>
        {file.name}
      </span>
      <span className="row__size">{formatBytes(file.size)}</span>

      {running && started && (
        <span className="row__bar">
          <ProgressBar value={progress} state="active" />
        </span>
      )}

      <span
        className={`row__state ${sent === total && total > 0 ? 'row__state--completed' : ''}`}
        title={running && started ? 'Sending' : undefined}
      >
        {total === 0 ? (
          'Waiting'
        ) : sent === total ? (
          <>
            <Icon name="check" size={13} />
            {total > 1 ? `Sent to ${total}` : 'Sent'}
          </>
        ) : started ? (
          <>
            <Way sending />
            {formatPercent(progress)}
          </>
        ) : (
          'Offered'
        )}
      </span>

      <span className="row__acts">
        <button
          type="button"
          className="button button--icon button--tiny"
          onClick={() => session.unshare(file.id)}
          aria-label={`Stop sharing ${file.name}`}
          title="Stop sharing"
        >
          <Icon name="x" size={14} />
        </button>
      </span>

      <button
        type="button"
        className={`row__toggle ${open ? 'is-open' : ''}`}
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        aria-label={`${open ? 'Hide' : 'Show'} devices for ${file.name}`}
        title={open ? 'Hide devices' : 'Devices'}
      >
        <Icon name="chevron" size={14} />
      </button>

      {open && (
        <div className="row__body">
          <SharedBody file={file} paths={paths} />
        </div>
      )}
    </li>
  )
}

/* ----------------------------------------------------------------- details */

const STORAGE_LABEL: Record<string, string> = {
  filesystem: 'Streamed to disk',
  opfs: 'Browser storage, then download',
  memory: 'In memory (small files only)'
}

/**
 * Seconds the transfer actually ran, or null while it is still running.
 *
 * Includes the verification tail, which finalizes an already-built hash tree
 * rather than re-reading the file, so it is short enough not to distort this.
 */
function elapsedSeconds(transfer: TransferView): number | null {
  if (transfer.startedAt === null || transfer.endedAt === null) return null
  const seconds = (transfer.endedAt - transfer.startedAt) / 1000
  return seconds > 0 ? seconds : null
}

function Details({transfer, path}: {transfer: TransferView; path?: NetworkPath}) {
  const done = transfer.state === 'COMPLETED'
  const elapsed = elapsedSeconds(transfer)

  const rows: [string, string][] = [
    ['From', transfer.peerName],
    ['Transferred', `${formatBytes(transfer.bytesTransferred)} / ${formatBytes(transfer.size)}`],
    // The live meter reads from a rolling window, so it has nothing to report
    // once the bytes stop. Finished transfers get the average over the run
    // instead of an empty row.
    done
      ? ['Average speed', formatSpeed(elapsed === null ? null : transfer.bytesTransferred / elapsed)]
      : ['Speed', formatSpeed(transfer.speed)],
    ['Type', transfer.mimeType]
  ]
  if (done && elapsed !== null) rows.push(['Took', formatDuration(elapsed)])
  // The round trip is the honest check on the label above: a link that really
  // is local answers in single-digit milliseconds, and one that says "Local
  // network" while measuring 25ms is not going the way it claims.
  if (path) {
    const rtt = path.roundTripMs === null ? '' : ` · ${Math.round(path.roundTripMs)} ms`
    rows.push(['Connection', `${path.network}${rtt}`])
  }
  if (transfer.storageKind) {
    rows.push(['Storage', STORAGE_LABEL[transfer.storageKind] ?? transfer.storageKind])
  }
  if (transfer.state === 'COMPLETED') {
    rows.push(['Integrity', transfer.verified ? 'SHA-256 chunk tree verified' : 'Not verified'])
  }

  return (
    <dl className="details">
      {rows.map(([label, value]) => (
        <div className="details__row" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}
