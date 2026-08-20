import {useState} from 'react'
import type {PathKind} from '../../lib/transport/Transport.ts'
import type {SharedFileView, TransferView} from '../../lib/transfer/states.ts'
import {isMoving, isQueued, isTerminal} from '../../lib/transfer/states.ts'
import {formatBytes, formatDuration, formatPercent, formatSpeed} from '../../lib/utils/format.ts'
import {session} from '../store.ts'
import {Icon, PathBadge, PathCost, ProgressBar, type IconName} from './common.tsx'

const STATE_LABEL: Record<TransferView['state'], string> = {
  QUEUED: 'Queued',
  WAITING_FOR_ACCEPT: 'Waiting',
  TRANSFERRING: 'Sending',
  PAUSED: 'Paused',
  RECONNECTING: 'Reconnecting',
  VERIFYING: 'Verifying',
  COMPLETED: 'Done',
  REJECTED: 'Declined',
  CANCELLED: 'Cancelled',
  FAILED: 'Failed'
}

/**
 * The same state means different words depending on which end you are on:
 * "Sending" is what the device with the file is doing, not what you are doing
 * while receiving it.
 */
const RECEIVE_LABEL: Partial<Record<TransferView['state'], string>> = {
  TRANSFERRING: 'Receiving'
}

/**
 * How each peer is currently reachable, keyed by peer id.
 *
 * Passed down rather than read from the store, so a path flipping from direct
 * to relay re-renders the rows that show it — the snapshot is what drives the
 * tree, and a component reaching around it would keep a stale label.
 */
export type PathLookup = ReadonlyMap<string, PathKind>

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

      {file.transfers.length === 0 ? (
        <p className="shared__waiting">
          Waiting for a device to join — it will be offered this file automatically.
        </p>
      ) : (
        <ul className="peerlines">
          {file.transfers.map(transfer => (
            <PeerLine key={transfer.id} transfer={transfer} kind={paths.get(transfer.peerId)} />
          ))}
        </ul>
      )}
    </li>
  )
}

/** How one device is doing with the file above it, and over what. */
function PeerLine({transfer, kind}: {transfer: TransferView; kind: PathKind | undefined}) {
  const {state} = transfer

  return (
    <li className="row row--peer">
      <span className="row__name">{transfer.peerName}</span>
      {/* Per device, not per file: a laptop on the same Wi-Fi and a phone on
          mobile data are the same file costing two very different things. */}
      {kind && !isTerminal(state) && <PathCost kind={kind} />}

      {isMoving(state) && (
        <span className="row__bar">
          <ProgressBar value={transfer.progress} state={state === 'RECONNECTING' ? 'error' : 'active'} />
        </span>
      )}

      <span className={`row__state row__state--${state.toLowerCase()}`}>
        {state === 'COMPLETED' && <Icon name="check" size={14} />}
        {state === 'TRANSFERRING'
          ? `${formatPercent(transfer.progress)} · ${formatSpeed(transfer.speed)}`
          : STATE_LABEL[state]}
      </span>

      <RowActions transfer={transfer} sending />
    </li>
  )
}

/** A file another device is offering to this one. */
export function IncomingFile({transfer, kind}: {transfer: TransferView; kind: PathKind | undefined}) {
  const [expanded, setExpanded] = useState(false)
  const {state} = transfer
  const queued = isQueued(transfer)

  return (
    <li className={`incoming incoming--${state.toLowerCase()}`}>
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
            {kind && (
              <>
                <span className="dot">·</span>
                <PathCost kind={kind} />
              </>
            )}
          </span>
        </div>
        {queued ? (
          <span className="incoming__state incoming__state--queued">Queued</span>
        ) : (
          state !== 'WAITING_FOR_ACCEPT' && (
            <span className={`incoming__state incoming__state--${state.toLowerCase()}`}>
              {state === 'COMPLETED' && <Icon name="check" size={15} />}
              {state === 'FAILED' && <Icon name="alert" size={15} />}
              {RECEIVE_LABEL[state] ?? STATE_LABEL[state]}
            </span>
          )
        )}
      </div>

      {transfer.storageWarning && (
        <p className="incoming__warning">
          <Icon name="alert" size={15} />
          {transfer.storageWarning}
        </p>
      )}

      {isMoving(state) && (
        <div className="incoming__progress">
          <ProgressBar value={transfer.progress} state={state === 'RECONNECTING' ? 'error' : 'active'} />
          <div className="incoming__numbers">
            <span className="incoming__percent">{formatPercent(transfer.progress)}</span>
            <span>
              {formatBytes(transfer.bytesTransferred)} / {formatBytes(transfer.size)}
            </span>
            {state === 'TRANSFERRING' && (
              <>
                <span className="incoming__speed">{formatSpeed(transfer.speed)}</span>
                <span>
                  {transfer.etaSeconds === null
                    ? 'Calculating…'
                    : `~${formatDuration(transfer.etaSeconds)} left`}
                </span>
              </>
            )}
            {state === 'VERIFYING' && <span>Verifying…</span>}
            {state === 'RECONNECTING' && (
              <span>Reconnecting — resumes from {formatBytes(transfer.bytesTransferred)}</span>
            )}
          </div>
        </div>
      )}

      {state === 'COMPLETED' && (
        <p className="incoming__outcome">
          <Icon name="shield" size={15} />
          {transfer.verified ? 'Verified. ' : ''}
          {transfer.savedToDisk ? 'Saved where you chose.' : 'Saved to your downloads.'}
        </p>
      )}

      {transfer.error && ['FAILED', 'REJECTED', 'CANCELLED'].includes(state) && (
        <p className="incoming__error">
          <strong>{transfer.error.title}</strong>
          <span>{transfer.error.message}</span>
        </p>
      )}

      <CardActions transfer={transfer} />

      {(isMoving(state) || state === 'COMPLETED') && (
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
          {expanded && <Details transfer={transfer} />}
        </>
      )}
    </li>
  )
}

/** The card's controls: full-size, labelled, one per rule. */
function CardActions({transfer}: {transfer: TransferView}) {
  const actions = actionsFor(transfer)
  if (actions.length === 0) return null

  return (
    <div className="incoming__actions">
      {isQueued(transfer) && (
        <span className="incoming__queued">Starts when the current download finishes.</span>
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
export function IncomingRow({transfer}: {transfer: TransferView}) {
  const {state} = transfer
  const queued = isQueued(transfer)
  const offered = state === 'WAITING_FOR_ACCEPT' && !queued

  return (
    <li className="row">
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
        <span className={`row__state row__state--${state.toLowerCase()}`}>
          {state === 'COMPLETED' && <Icon name="check" size={13} />}
          {state === 'TRANSFERRING'
            ? formatPercent(transfer.progress)
            : queued
              ? 'Queued'
              : (RECEIVE_LABEL[state] ?? STATE_LABEL[state])}
        </span>
      )}

      <RowActions transfer={transfer} />

      {transfer.storageWarning && (
        <p className="row__warning">
          <Icon name="alert" size={13} />
          {transfer.storageWarning}
        </p>
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
export function SharedRow({file}: {file: SharedFileView}) {
  const total = file.transfers.length
  const sent = file.transfers.filter(transfer => transfer.state === 'COMPLETED').length
  const running = file.transfers.some(transfer => !isTerminal(transfer.state))
  const started = file.transfers.some(transfer => transfer.state !== 'WAITING_FOR_ACCEPT')
  const progress = total === 0 ? 0 : file.transfers.reduce((sum, t) => sum + t.progress, 0) / total

  return (
    <li className="row">
      <span className="row__name" title={file.name}>
        {file.name}
      </span>
      <span className="row__size">{formatBytes(file.size)}</span>

      {running && started && (
        <span className="row__bar">
          <ProgressBar value={progress} state="active" />
        </span>
      )}

      <span className={`row__state ${sent === total && total > 0 ? 'row__state--completed' : ''}`}>
        {total === 0 ? (
          'Waiting'
        ) : sent === total ? (
          <>
            <Icon name="check" size={13} />
            {total > 1 ? `Sent to ${total}` : 'Sent'}
          </>
        ) : started ? (
          formatPercent(progress)
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

function Details({transfer}: {transfer: TransferView}) {
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

export {PathBadge}
