import {memo, useState} from 'react'
import type {NetworkPath} from '../../lib/transport/Transport.ts'
import type {SharedFileView, TransferView} from '../../lib/transfer/states.ts'
import {isMoving, isQueued, isTerminal} from '../../lib/transfer/states.ts'
import {formatBytes, formatPercent, formatSpeed} from '../../lib/utils/format.ts'
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
 * The rules for what a receiver can do, in one place: the same buttons
 * whether a file arrived on its own or as one of a batch.
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
 * Which way the bytes are going. While a file moves its state is a bare
 * percentage, so a file going out and one coming in would read identically;
 * this is the smallest mark that separates them.
 */
function Way({sending}: {sending: boolean}) {
  return <Icon name={sending ? 'upload' : 'download'} size={12} />
}

/* ------------------------------------------------------------------ states */

/**
 * Why a file failed, when that says more than "Failed" does. A decline or a
 * cancel is its own explanation; a stall, a lost connection or a failed
 * integrity check is not.
 */
function failureReason(transfer: TransferView): string | null {
  const {state, error} = transfer
  if (!isTerminal(state) || !error || SELF_EVIDENT.has(error.code)) return null
  return error.message
}

/**
 * Where a file coming in stands, in the same words on a card and in a row:
 * the percentage and the speed while it moves, a tick once it has landed.
 */
function ReceiveState({transfer}: {transfer: TransferView}) {
  const {state} = transfer
  const running = state === 'TRANSFERRING'
  return (
    <span
      className={`row__state state--${tone(transfer)}`}
      title={state === 'COMPLETED' ? 'SHA-256 verified' : running ? 'Receiving' : undefined}
      aria-label={
        running ? `Receiving, ${formatPercent(transfer.progress)}, ${formatSpeed(transfer.speed)}` : undefined
      }
    >
      {state === 'COMPLETED' && <Icon name="check" size={13} />}
      {running && <Way sending={false} />}
      {running
        ? transfer.speed === null
          ? formatPercent(transfer.progress)
          : `${formatPercent(transfer.progress)} · ${formatSpeed(transfer.speed)}`
        : label(transfer, 'receive')}
    </span>
  )
}

/** One shared file's progress, across every device it is going to. */
function sharedProgress(file: SharedFileView): number {
  if (file.transfers.length === 0) return 0
  return (
    file.transfers.reduce((sum, t) => sum + (t.state === 'COMPLETED' ? 1 : t.progress), 0) /
    file.transfers.length
  )
}

/** "Pixel 8", or "3 devices" when a file went to several. */
function recipients(transfers: readonly TransferView[]): string {
  const names = [...new Set(transfers.map(t => t.peerName))]
  return names.length === 1 ? names[0]! : `${names.length} devices`
}

/**
 * Where a file going out stands, summed across every device it was offered
 * to — "Waiting for Pixel 8", "40% · 1 of 3", "Sent to 2", or what became of
 * it when it did not go, rather than the "0%" a declined file used to show.
 */
function SendState({file}: {file: SharedFileView}) {
  const total = file.transfers.length
  const sent = file.transfers.filter(transfer => transfer.state === 'COMPLETED').length
  const running = file.transfers.some(transfer => !isTerminal(transfer.state))
  const moving = file.transfers.some(transfer => isMoving(transfer.state))
  const only = total === 1 ? file.transfers[0]! : null
  const ended = total > 0 && !running && sent < total

  let content
  if (total === 0) content = 'Waiting for a device'
  else if (sent === total)
    content = (
      <>
        <Icon name="check" size={13} />
        {total > 1 ? `Sent to ${total}` : 'Sent'}
      </>
    )
  else if (moving)
    content = (
      <>
        <Way sending />
        {formatPercent(sharedProgress(file))}
        {total > 1 && ` · ${sent} of ${total}`}
      </>
    )
  else if (running) content = sent === 0 ? `Waiting for ${recipients(file.transfers)}` : `Sent to ${sent} of ${total}`
  else if (ended && only) content = label(only, 'send')
  else content = `Sent to ${sent} of ${total}`

  const className =
    sent === total && total > 0 ? 'row__state--completed' : ended && only ? `state--${tone(only)}` : ''
  return (
    <span className={`row__state ${className}`} title={moving ? 'Sending' : undefined}>
      {content}
    </span>
  )
}

/* -------------------------------------------------------------------- rows */

/**
 * One file inside a drop of several, on a single line — the same line whether
 * it is coming in or going out: its name, its size, a bar while it moves,
 * where it stands, and what you can do about it. Nothing opens beneath it; the
 * reason a file failed shows under its name.
 */
export const IncomingRow = memo(function IncomingRow({transfer}: {transfer: TransferView}) {
  const offered = transfer.state === 'WAITING_FOR_ACCEPT' && !isQueued(transfer)
  const note = failureReason(transfer) ?? transfer.storageWarning

  return (
    <li className="row">
      <span className="row__name" title={transfer.name}>
        {transfer.name}
      </span>
      <span className="row__size">{formatBytes(transfer.size)}</span>
      {isMoving(transfer.state) && (
        <span className="row__bar">
          <ProgressBar value={transfer.progress} state={transfer.state === 'RECONNECTING' ? 'error' : 'active'} />
        </span>
      )}
      {/* An undecided file shows its Download button where the state would be —
          the button is the state. */}
      {!offered && <ReceiveState transfer={transfer} />}
      <RowActions transfer={transfer} />
      {note && <Warning bad={failureReason(transfer) !== null}>{note}</Warning>}
    </li>
  )
})

export const SharedRow = memo(function SharedRow({file}: {file: SharedFileView}) {
  const moving = file.transfers.some(transfer => isMoving(transfer.state))
  return (
    <li className="row">
      <span className="row__name" title={file.name}>
        {file.name}
      </span>
      <span className="row__size">{formatBytes(file.size)}</span>
      {moving && (
        <span className="row__bar">
          <ProgressBar value={sharedProgress(file)} state="active" />
        </span>
      )}
      <SendState file={file} />
      <SendActions files={[file]} />
    </li>
  )
})

/** Storage advice before you decide, or why a file failed after. A sentence, so a line of its own. */
function Warning({bad, children}: {bad: boolean; children: string}) {
  return (
    <p className={`row__warning ${bad ? 'row__warning--bad' : ''}`}>
      <Icon name="alert" size={13} />
      {children}
    </p>
  )
}

/**
 * A row's controls: the primary one keeps its label because it is the whole
 * point of the row, the rest shrink to icons so the controls cost a line's
 * height and no more.
 */
function RowActions({transfer}: {transfer: TransferView}) {
  const actions = actionsFor(transfer)
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

/** Retry whatever failed to send, and stop sharing — for one file or for a whole drop. */
function SendActions({files}: {files: readonly SharedFileView[]}) {
  const retryable = files.flatMap(file => file.transfers).filter(transfer => transfer.canRetry)
  const what = files.length === 1 ? files[0]!.name : `all ${files.length} files`
  return (
    <span className="row__acts">
      {retryable.length > 0 && (
        <button
          type="button"
          className="button button--icon button--tiny"
          onClick={() => retryable.forEach(transfer => session.retry(transfer.id))}
          aria-label={`Retry ${what}`}
          title="Retry"
        >
          <Icon name="retry" size={14} />
        </button>
      )}
      <button
        type="button"
        className="button button--icon button--tiny"
        onClick={() => files.forEach(file => session.unshare(file.id))}
        aria-label={`Stop sharing ${what}`}
        title={files.length === 1 ? 'Stop sharing' : 'Stop sharing all'}
      >
        <Icon name="x" size={14} />
      </button>
    </span>
  )
}

/* ------------------------------------------------------------------- cards */

/*
 * One card per drop, whether it held one file or a hundred.
 *
 * A file sent on its own used to get a card of its own design — full-size
 * buttons, a speed line, a details panel, a line per device — while the same
 * file sent alongside others got a compact row with different controls. Two
 * layouts for one thing meant two things to learn and two places for the same
 * bug to be fixed in one and not the other. Now every drop is the same card:
 * a header that says what it is and where it stands, and, when it holds more
 * than one file, the same rows inside it. A drop of one is just the header,
 * carrying that file's own state and buttons.
 */

export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i])
}

/** Drops are regrouped every render; an unchanged one is the same files in the same order. */
function sameDrop<T>(
  prev: {files: readonly T[]; paths: PathLookup},
  next: {files: readonly T[]; paths: PathLookup}
): boolean {
  return prev.paths === next.paths && sameItems(prev.files, next.files)
}

/** Show / Hide for a drop's files. The count is on the button: that is the question it answers. */
function DropToggle({open, count, onToggle}: {open: boolean; count: number; onToggle: () => void}) {
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
 * How far along a whole drop is, drawn on the card's bottom edge — where it
 * costs three pixels and never moves anything. Measured in bytes, not files:
 * counted by files, three photos and a video sat at three quarters for the
 * whole of the video.
 */
function DropRail({value, complete}: {value: number; complete: boolean}) {
  return (
    <span className="batch__rail">
      <ProgressBar value={complete ? 1 : value} state={complete ? 'done' : 'active'} />
    </span>
  )
}

function bytesDone<T extends {size: number}>(files: readonly T[], progressOf: (file: T) => number): number {
  const total = files.reduce((sum, file) => sum + file.size, 0)
  if (total === 0) return 0
  return files.reduce((sum, file) => sum + file.size * progressOf(file), 0) / total
}

/** A drop you are sending. */
export const SharedDrop = memo(function SharedDrop({files, paths}: {files: SharedFileView[]; paths: PathLookup}) {
  const [open, setOpen] = useState(false)
  const single = files.length === 1 ? files[0]! : null
  const transfers = files.flatMap(file => file.transfers)
  const bytes = files.reduce((total, file) => total + file.size, 0)
  // Sent once it has reached a device and nothing more is pending for it. A
  // device that dropped out, or declined, does not hold every other file at
  // "0 of 3 sent" — the row says which devices have it, and offers a retry.
  const done = files.filter(
    file =>
      file.transfers.some(t => t.state === 'COMPLETED') &&
      file.transfers.every(t => isTerminal(t.state))
  ).length
  const started = transfers.some(t => t.state !== 'WAITING_FOR_ACCEPT')
  // A drop goes to every device in the room, and they need not be reachable
  // the same way. One label is only honest when they all agree.
  const kinds = new Set(transfers.map(t => paths.get(t.peerId)?.kind))
  const sharedKind = kinds.size === 1 ? [...kinds][0] : undefined

  return (
    <li className="batch">
      <div className="batch__head">
        <span className="batch__icon" aria-hidden="true">
          <Icon name="upload" size={16} />
        </span>
        <div className="batch__ident">
          <span className="batch__name" title={single?.name}>
            {single ? single.name : `${files.length} files`}
          </span>
          <span className="batch__meta">
            <span className="meta__field">{formatBytes(bytes)}</span>
            {/* No separator before the badge: a pill is already visually
                self-contained, and a dot beside it reads as a stray mark. */}
            {sharedKind && <PathCost kind={sharedKind} />}
            <span className="dot">·</span>
            {single ? (
              <SendState file={single} />
            ) : transfers.length === 0 ? (
              <span className="meta__field">Waiting for a device</span>
            ) : !started ? (
              <span className="meta__field">Waiting for {recipients(transfers)}</span>
            ) : (
              <span className="meta__field">
                {done} of {files.length} sent
              </span>
            )}
          </span>
        </div>
        <SendActions files={files} />
        {!single && <DropToggle open={open} count={files.length} onToggle={() => setOpen(value => !value)} />}
      </div>

      {started && (
        <DropRail value={bytesDone(files, sharedProgress)} complete={done === files.length} />
      )}

      {!single && open && (
        <ul className="batch__items">
          {files.map(file => (
            <SharedRow key={file.id} file={file} />
          ))}
        </ul>
      )}
    </li>
  )
}, sameDrop)

/** A drop coming in. Every file in it is from one device. */
export const IncomingDrop = memo(function IncomingDrop({files, paths}: {files: TransferView[]; paths: PathLookup}) {
  const [open, setOpen] = useState(false)
  const single = files.length === 1 ? files[0]! : null
  const bytes = files.reduce((total, file) => total + file.size, 0)
  const done = files.filter(file => file.state === 'COMPLETED').length
  const started = done > 0 || files.some(file => file.state !== 'WAITING_FOR_ACCEPT')
  // Only the ones still waiting on a decision; already queued or running files
  // must not be re-accepted.
  const undecided = files.filter(file => file.state === 'WAITING_FOR_ACCEPT' && !isQueued(file))
  const kind = files[0] ? paths.get(files[0].peerId)?.kind : undefined
  const note = single ? (failureReason(single) ?? single.storageWarning) : null

  return (
    <li className={`batch ${undecided.length > 0 ? 'batch--offer' : ''}`}>
      {/* Stacked while there is a decision to make: on a phone the summary gets
          the full width and the buttons a row of their own. */}
      <div className={`batch__head ${undecided.length > 0 ? 'batch__head--stacked' : ''}`}>
        <span className="batch__icon batch__icon--in" aria-hidden="true">
          <Icon name="download" size={16} />
        </span>
        <div className="batch__ident">
          <span className="batch__name" title={single?.name}>
            {single ? single.name : `${files.length} files`}
          </span>
          <span className="batch__meta">
            <span className="meta__field">{formatBytes(bytes)}</span>
            <span className="dot">·</span>
            <span className="meta__field">from {files[0]?.peerName}</span>
            {kind && <PathCost kind={kind} />}
            {single
              ? undecided.length === 0 && (
                  <>
                    <span className="dot">·</span>
                    <ReceiveState transfer={single} />
                  </>
                )
              : started && (
                  <>
                    <span className="dot">·</span>
                    <span className="meta__field">
                      {done} of {files.length} downloaded
                    </span>
                  </>
                )}
          </span>
        </div>
        {single ? (
          <RowActions transfer={single} />
        ) : (
          undecided.length > 0 && (
            <button
              type="button"
              className="button button--primary button--small"
              onClick={() => undecided.forEach(file => session.accept(file.id))}
            >
              <Icon name="download" size={14} /> Download all
            </button>
          )
        )}
        {!single && <DropToggle open={open} count={files.length} onToggle={() => setOpen(value => !value)} />}
      </div>

      {note && <Warning bad={failureReason(single!) !== null}>{note}</Warning>}

      {started && (
        <DropRail
          value={bytesDone(files, file => (file.state === 'COMPLETED' ? 1 : file.progress))}
          complete={done === files.length}
        />
      )}

      {!single && open && (
        <ul className="batch__items">
          {files.map(file => (
            <IncomingRow key={file.id} transfer={file} />
          ))}
        </ul>
      )}
    </li>
  )
}, sameDrop)
