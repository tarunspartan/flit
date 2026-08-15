import {useState} from 'react'
import type {SharedFileView, TransferView} from '../../lib/transfer/states.ts'
import {formatBytes, formatDuration, formatPercent, formatSpeed} from '../../lib/utils/format.ts'
import {session} from '../store.ts'
import {Icon, PathBadge, ProgressBar} from './common.tsx'

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

/** One dropped file, with a line per device it is going to. */
export function SharedFile({file}: {file: SharedFileView}) {
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
            <PeerLine key={transfer.id} transfer={transfer} />
          ))}
        </ul>
      )}
    </li>
  )
}

function PeerLine({transfer}: {transfer: TransferView}) {
  const active = ['TRANSFERRING', 'PAUSED', 'RECONNECTING', 'VERIFYING'].includes(transfer.state)

  return (
    <li className={`peerline peerline--${transfer.state.toLowerCase()}`}>
      <span className="peerline__name">{transfer.peerName}</span>

      {active ? (
        <span className="peerline__progress">
          <ProgressBar
            value={transfer.progress}
            state={transfer.state === 'RECONNECTING' ? 'error' : 'active'}
          />
        </span>
      ) : (
        <span className="peerline__spacer" />
      )}

      <span className={`peerline__state peerline__state--${transfer.state.toLowerCase()}`}>
        {transfer.state === 'COMPLETED' && <Icon name="check" size={14} />}
        {transfer.state === 'TRANSFERRING'
          ? `${formatPercent(transfer.progress)} · ${formatSpeed(transfer.speed)}`
          : STATE_LABEL[transfer.state]}
      </span>

      {transfer.state === 'TRANSFERRING' && (
        <button
          type="button"
          className="button button--icon"
          onClick={() => session.pause(transfer.id)}
          aria-label="Pause"
        >
          <Icon name="pause" size={14} />
        </button>
      )}
      {transfer.state === 'PAUSED' && (
        <button
          type="button"
          className="button button--icon"
          onClick={() => session.resume(transfer.id)}
          aria-label="Resume"
        >
          <Icon name="play" size={14} />
        </button>
      )}
      {transfer.canRetry && (
        <button
          type="button"
          className="button button--icon"
          onClick={() => session.retry(transfer.id)}
          aria-label="Retry"
        >
          <Icon name="retry" size={14} />
        </button>
      )}
    </li>
  )
}

/** A file another device is offering to this one. */
export function IncomingFile({transfer}: {transfer: TransferView}) {
  const [expanded, setExpanded] = useState(false)
  const {state} = transfer
  const showProgress = ['TRANSFERRING', 'PAUSED', 'RECONNECTING', 'VERIFYING'].includes(state)

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
          <span className="incoming__meta">
            {formatBytes(transfer.size)}
            <span className="dot">·</span>
            from {transfer.peerName}
          </span>
        </div>
        {state !== 'WAITING_FOR_ACCEPT' && (
          <span className={`incoming__state incoming__state--${state.toLowerCase()}`}>
            {state === 'COMPLETED' && <Icon name="check" size={15} />}
            {state === 'FAILED' && <Icon name="alert" size={15} />}
            {STATE_LABEL[state]}
          </span>
        )}
      </div>

      {transfer.storageWarning && (
        <p className="incoming__warning">
          <Icon name="alert" size={15} />
          {transfer.storageWarning}
        </p>
      )}

      {showProgress && (
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

      <IncomingActions transfer={transfer} />

      {(showProgress || state === 'COMPLETED') && (
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

function IncomingActions({transfer}: {transfer: TransferView}) {
  const {id, state} = transfer

  if (state === 'WAITING_FOR_ACCEPT') {
    return (
      <div className="incoming__actions">
        {/* Accepting *is* the download, so the button says what it does. */}
        <button type="button" className="button button--primary" onClick={() => session.accept(id)}>
          <Icon name="download" size={16} /> Download
        </button>
        <button type="button" className="button button--ghost" onClick={() => session.reject(id)}>
          Decline
        </button>
      </div>
    )
  }

  const buttons = []
  if (state === 'TRANSFERRING') {
    buttons.push(
      <button key="p" type="button" className="button button--small" onClick={() => session.pause(id)}>
        <Icon name="pause" size={14} /> Pause
      </button>
    )
  }
  if (state === 'PAUSED') {
    buttons.push(
      <button key="r" type="button" className="button button--small" onClick={() => session.resume(id)}>
        <Icon name="play" size={14} /> Resume
      </button>
    )
  }
  if (transfer.canCancel) {
    buttons.push(
      <button key="c" type="button" className="button button--small" onClick={() => session.cancel(id)}>
        <Icon name="x" size={14} /> Cancel
      </button>
    )
  }
  if (transfer.downloadReady && state === 'COMPLETED') {
    buttons.push(
      <button key="s" type="button" className="button button--small" onClick={() => session.saveAgain(id)}>
        <Icon name="save" size={14} /> Save again
      </button>
    )
  }

  if (buttons.length === 0) return null
  return <div className="incoming__actions">{buttons}</div>
}

const STORAGE_LABEL: Record<string, string> = {
  filesystem: 'Streamed to disk',
  opfs: 'Browser storage, then download',
  memory: 'In memory (small files only)'
}

function Details({transfer}: {transfer: TransferView}) {
  const rows: [string, string][] = [
    ['From', transfer.peerName],
    ['Transferred', `${formatBytes(transfer.bytesTransferred)} / ${formatBytes(transfer.size)}`],
    ['Speed', formatSpeed(transfer.speed)],
    ['Type', transfer.mimeType]
  ]
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
