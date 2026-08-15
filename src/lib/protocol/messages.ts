/**
 * Transfer Protocol v1 (spec §73).
 *
 * Trystero/WebRTC owns transport and connectivity. This layer owns transfer
 * semantics: offers, consent, checkpoints, resume, verification and teardown.
 *
 * Control messages are JSON on the `ctrl` action. File bytes are binary frames
 * on the `chunk` action (see frame.ts) — never JSON, so payloads are not
 * base64-inflated.
 */

export const PROTOCOL_VERSION = 1

/** Peers differing in major version cannot interoperate and must say so (§73.5). */
export const MIN_COMPATIBLE_VERSION = 1

export const HASH_ALGORITHM = 'sha256-chunktree-v1'

export type MessageType =
  | 'HELLO'
  | 'TRANSFER_OFFER'
  | 'TRANSFER_ACCEPT'
  | 'TRANSFER_REJECT'
  | 'TRANSFER_PAUSE'
  | 'TRANSFER_RESUME'
  | 'TRANSFER_FLOW'
  | 'TRANSFER_CHECKPOINT'
  | 'TRANSFER_CANCEL'
  | 'TRANSFER_COMPLETE'
  | 'TRANSFER_VERIFY'
  | 'TRANSFER_ERROR'
  | 'SESSION_APPROVE'
  | 'SESSION_END'

interface Base<T extends MessageType> {
  /** Protocol version, on every message (§73.1). */
  v: number
  t: T
}

export interface Hello extends Base<'HELLO'> {
  sessionId: string
  deviceName: string
  deviceKind: string
  /** What this peer is willing to receive, so the sender can fail fast. */
  maxFileSize: number
  supportsResume: boolean
}

export interface TransferOffer extends Base<'TRANSFER_OFFER'> {
  transferId: string
  /** Compact id used in binary frames; unique within a session. */
  seq: number
  name: string
  size: number
  mimeType: string
  lastModified: number
  chunkSize: number
  totalChunks: number
  hashAlgorithm: string
  /** Relative path for folder transfers; always sanitized on receipt. */
  relPath?: string
}

/**
 * The receiver's go-ahead. Sent once on consent and again after a successful
 * resume negotiation — in both cases it means "send me chunks from here".
 */
export interface TransferAccept extends Base<'TRANSFER_ACCEPT'> {
  transferId: string
  /** First chunk the receiver still needs — non-zero when resuming. */
  fromChunk: number
}

export interface TransferReject extends Base<'TRANSFER_REJECT'> {
  transferId: string
  reason: 'declined' | 'too-large' | 'no-storage' | 'busy'
}

/** User-initiated pause, from either side. */
export interface TransferPause extends Base<'TRANSFER_PAUSE'> {
  transferId: string
}

/**
 * Receiver-side backpressure, kept distinct from a user pause so the two can
 * never cancel each other out. Raised when writes fall behind the network and
 * lowered once the write queue drains.
 */
export interface TransferFlow extends Base<'TRANSFER_FLOW'> {
  transferId: string
  paused: boolean
}

/**
 * Sent by either side to restart the byte flow: after an explicit pause, or
 * after reconnecting. `identity` lets the receiver confirm it is the same file
 * before appending to a partial one (§74.3).
 */
export interface TransferResume extends Base<'TRANSFER_RESUME'> {
  transferId: string
  identity: {size: number; lastModified: number; chunkSize: number}
}

/** Receiver → sender: everything below `chunks` is durably stored (§73.4). */
export interface TransferCheckpoint extends Base<'TRANSFER_CHECKPOINT'> {
  transferId: string
  /** Count of contiguous chunks written from index 0. */
  chunks: number
  bytes: number
}

export interface TransferCancel extends Base<'TRANSFER_CANCEL'> {
  transferId: string
  reason: 'user' | 'error' | 'storage' | 'shutdown'
}

/** Sender → receiver: all chunks are out, here is the expected content hash. */
export interface TransferComplete extends Base<'TRANSFER_COMPLETE'> {
  transferId: string
  contentHash: string
}

/** Receiver → sender: the verification verdict (§15). */
export interface TransferVerify extends Base<'TRANSFER_VERIFY'> {
  transferId: string
  ok: boolean
  contentHash: string
}

export interface TransferError extends Base<'TRANSFER_ERROR'> {
  transferId?: string
  code: string
  detail?: string
}

/**
 * Device trust (§76). The host explicitly allows or blocks the device that
 * joined; until this arrives, nothing but HELLO is accepted from that peer.
 */
export interface SessionApprove extends Base<'SESSION_APPROVE'> {
  approved: boolean
}

export interface SessionEnd extends Base<'SESSION_END'> {
  reason: 'user' | 'expired' | 'blocked' | 'full'
}

export type ControlMessage =
  | Hello
  | TransferOffer
  | TransferAccept
  | TransferReject
  | TransferPause
  | TransferResume
  | TransferFlow
  | TransferCheckpoint
  | TransferCancel
  | TransferComplete
  | TransferVerify
  | TransferError
  | SessionApprove
  | SessionEnd

/** Distributes over the union so each variant keeps its own required fields. */
type WithoutVersion<T> = T extends ControlMessage ? Omit<T, 'v'> : never

/** Stamps the protocol version onto an outgoing message (§73.1). */
export function message<M extends WithoutVersion<ControlMessage>>(msg: M): ControlMessage {
  return {...msg, v: PROTOCOL_VERSION} as unknown as ControlMessage
}
