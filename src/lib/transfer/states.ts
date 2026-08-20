import type {ErrorCode} from '../core/errors.ts'
import type {StoreKind} from '../storage/types.ts'

/**
 * The transfer state machine (spec §11), defined independently of the UI so it
 * can be tested and reasoned about on its own.
 */
export type TransferState =
  | 'QUEUED'
  | 'WAITING_FOR_ACCEPT'
  | 'TRANSFERRING'
  | 'PAUSED'
  | 'RECONNECTING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'FAILED'

export type Direction = 'send' | 'receive'

const TRANSITIONS: Record<TransferState, readonly TransferState[]> = {
  QUEUED: ['WAITING_FOR_ACCEPT', 'CANCELLED', 'FAILED'],
  WAITING_FOR_ACCEPT: ['TRANSFERRING', 'REJECTED', 'CANCELLED', 'FAILED', 'RECONNECTING'],
  TRANSFERRING: ['PAUSED', 'RECONNECTING', 'VERIFYING', 'CANCELLED', 'FAILED'],
  PAUSED: ['TRANSFERRING', 'RECONNECTING', 'CANCELLED', 'FAILED'],
  // Reconnecting can land back in WAITING_FOR_ACCEPT: resume is renegotiated.
  // It can also go straight to VERIFYING when every byte was already sent and
  // only the verification handshake was lost with the connection.
  RECONNECTING: ['TRANSFERRING', 'WAITING_FOR_ACCEPT', 'VERIFYING', 'CANCELLED', 'FAILED'],
  // Verification is not a point of no return: the connection can still drop,
  // and a receiver that lost chunks can ask for more even after the sender
  // believed it was done.
  VERIFYING: ['COMPLETED', 'FAILED', 'CANCELLED', 'RECONNECTING', 'TRANSFERRING'],
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: [],
  FAILED: []
}

const TERMINAL_STATES: readonly TransferState[] = [
  'COMPLETED',
  'REJECTED',
  'CANCELLED',
  'FAILED'
]

export function isTerminal(state: TransferState): boolean {
  return TERMINAL_STATES.includes(state)
}

export function canTransition(from: TransferState, to: TransferState): boolean {
  return TRANSITIONS[from].includes(to)
}

/** True while the transfer is expected to be moving or about to move bytes. */
export function isActive(state: TransferState): boolean {
  return state === 'TRANSFERRING' || state === 'PAUSED' || state === 'RECONNECTING'
}

/**
 * True while there is progress worth drawing a bar for.
 *
 * `isActive` plus the verification tail: no bytes move during VERIFYING, but
 * from the user's side it is the same wait, and dropping the bar there would
 * make a finishing transfer look like it had stalled.
 */
export function isMoving(state: TransferState): boolean {
  return isActive(state) || state === 'VERIFYING'
}

/** One dropped file, offered to every device that joins the room. */
export interface SharedFileView {
  id: string
  name: string
  size: number
  addedAt: number
  /** Shared by everything dropped in one action, so the UI can fold it up. */
  batchId: string
  /** One entry per device the file has been offered to. */
  transfers: TransferView[]
}

/**
 * Accepted, but another download from the same device is still running.
 *
 * Still WAITING_FOR_ACCEPT on the wire — the accept is what has been held back
 * — so a queue position is the only thing that separates "waiting for you" from
 * "waiting for its turn". Written out in four places before this existed.
 */
export function isQueued(view: TransferView): boolean {
  return view.state === 'WAITING_FOR_ACCEPT' && view.queuePosition !== null
}

export interface TransferError {
  code: ErrorCode
  title: string
  message: string
  retryable: boolean
}

/** The immutable snapshot the UI renders. */
export interface TransferView {
  id: string
  direction: Direction
  /** Which device this transfer is with — rooms hold more than two. */
  peerId: string
  peerName: string
  state: TransferState
  name: string
  size: number
  mimeType: string
  bytesTransferred: number
  progress: number
  speed: number | null
  etaSeconds: number | null
  queuePosition: number | null
  /** Files dropped together share one id, so the UI can group them. */
  batchId: string | null
  error: TransferError | null
  verified: boolean
  storageKind: StoreKind | null
  savedToDisk: boolean
  /** Set when the file is waiting for the user to save it manually. */
  downloadReady: boolean
  /** Free-space advice shown next to Accept, when there is any. */
  storageWarning: string | null
  startedAt: number | null
  endedAt: number | null
  canRetry: boolean
  canPause: boolean
  canCancel: boolean
}
