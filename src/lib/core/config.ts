/**
 * Every tunable limit in one place. Deployments are expected to override the
 * abuse-control values (spec §79) rather than have them scattered in code.
 */

export const APP_ID = 'flit-v1'

/** Application-level chunk size. Trystero splits these into 16 KiB wire frames. */
export const CHUNK_SIZE = 256 * 1024

/**
 * How many chunk sends may be outstanding at once. Bounds sender memory to
 * MAX_IN_FLIGHT_CHUNKS * CHUNK_SIZE while keeping the DataChannel pipeline full.
 */
export const MAX_IN_FLIGHT_CHUNKS = 8

/** Receiver acknowledges a checkpoint at most this often (§73.4). */
export const CHECKPOINT_INTERVAL_BYTES = 8 * 1024 * 1024
export const CHECKPOINT_INTERVAL_MS = 2000

/** UI progress events are coalesced to this cadence to keep React cheap. */
export const PROGRESS_EMIT_INTERVAL_MS = 200

/**
 * How many devices may share a room. Everyone in the room can send to, and
 * receive from, everyone else.
 */
export const MAX_PEERS = 8

/** Abuse / resource limits (§79). */
export const LIMITS = {
  maxFileSize: 64 * 1024 ** 3,
  maxFilesPerSession: 500,
  maxQueuedBytes: 256 * 1024 ** 3,
  maxFilenameLength: 255,
  maxControlMessageBytes: 16 * 1024,
  /** Control messages accepted from a peer per second before we start dropping. */
  maxControlMessagesPerSecond: 200,
  /**
   * How long a room's code keeps working. Devices are expected to join long
   * after the files were dropped, so this is a session lifetime rather than a
   * short pairing window.
   */
  roomLifetimeMs: 6 * 60 * 60 * 1000,
  /** Wrong-code entries allowed locally before we throttle join attempts. */
  maxJoinAttempts: 8,
  joinAttemptWindowMs: 60 * 1000
} as const

/** Peer / transfer timeouts. */
export const TIMEOUTS = {
  /** No bytes and no control traffic for this long ⇒ treat transfer as stalled. */
  transferStallMs: 30_000,
  /** How long we keep trying to re-pair after the peer drops before giving up. */
  reconnectWindowMs: 2 * 60 * 1000,
  /** Time to wait for a peer to answer a resume negotiation. */
  resumeNegotiationMs: 15_000,
  /** How long a receiver waits for the sender's first chunk after accepting. */
  transferStartMs: 20_000
} as const

/** Memory-mode receiving is capped: above this we require a real storage tier. */
export const MEMORY_STORE_MAX_BYTES = 512 * 1024 * 1024

/**
 * Above this size, offer the save picker so the bytes land on disk once
 * instead of filling OPFS and then being copied again by a browser download.
 */
export const PICKER_MIN_BYTES = 256 * 1024 * 1024

/**
 * Public STUN only. STUN just tells a browser how it looks from outside; it
 * never carries file data, needs no account, and costs nothing to use — so the
 * project stays free of any infrastructure to maintain.
 *
 * The trade-off is deliberate and stated in the UI: without a TURN relay,
 * networks that block direct peer connections (symmetric NAT, some corporate
 * and captive Wi-Fi) cannot be traversed, and the app says so plainly instead
 * of silently routing your files through a server.
 */
export const STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
  'stun:stun.nextcloud.com:443'
]
