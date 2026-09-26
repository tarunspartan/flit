/**
 * Every tunable limit in one place. Deployments are expected to override the
 * abuse-control values (spec §79) rather than have them scattered in code.
 */

export const APP_ID = 'flit-v1'

/**
 * Largest application-level chunk. The size actually used for a transfer can be
 * smaller: each chunk travels as one data channel message, so it is capped by
 * the SCTP max-message-size the two browsers negotiated (see chunkSizeFor).
 */
export const CHUNK_SIZE = 256 * 1024

/**
 * How many chunks may be being read, hashed and handed to the channel at once.
 * Bounds sender memory to MAX_IN_FLIGHT_CHUNKS * CHUNK_SIZE on top of the
 * channel's own buffer, whatever the file size.
 */
export const MAX_IN_FLIGHT_CHUNKS = 8

/**
 * The file-data channel's send buffer.
 *
 * A send waits while more than HIGH is queued and resumes once the browser has
 * drained it to LOW. The gap keeps the SCTP pipe full between wake-ups without
 * holding much more than a round trip's worth of data: control messages travel
 * on a different channel, so a deep buffer here no longer delays a Pause.
 */
export const BULK_HIGH_WATER = 4 * 1024 * 1024
export const BULK_LOW_WATER = 1024 * 1024

/**
 * Files at or below this size may download a few at a time. For a small file
 * the round trips around it — accept, verify, save — cost more than its bytes,
 * so running them one by one leaves the link idle most of the time.
 */
export const SMALL_FILE_BYTES = 8 * 1024 * 1024
export const MAX_PARALLEL_SMALL_DOWNLOADS = 4

/**
 * How fast offers go out. A drop of hundreds of files is metadata only, but a
 * peer's control channel is rate limited, so offers are paced well inside it.
 */
export const OFFERS_PER_SECOND = 100

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
  /** A link or a short note. Well inside maxControlMessageBytes even in UTF-8. */
  maxTextLength: 2000,
  maxControlMessageBytes: 16 * 1024,
  /** Control messages accepted from a peer per second before we start dropping. */
  maxControlMessagesPerSecond: 200,
  /**
   * How many may arrive at once. Must cover a whole session's worth of offers:
   * a device joining a room is offered everything shared so far in one go, and
   * an older build sends those unpaced.
   */
  maxControlMessageBurst: 600,
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
  /**
   * How long a message that expects an answer waits before it is sent again.
   *
   * A message can be lost without either end seeing an error — the channel it
   * was queued on closed, or it went out while the peer was between
   * connections. Every message that is resent is idempotent at the far end, so
   * asking again is always safe, and several retries fit inside one stall
   * window before the transfer is given up on.
   */
  retryMs: 5_000
} as const

/** Memory-mode receiving is capped: above this we require a real storage tier. */
export const MEMORY_STORE_MAX_BYTES = 512 * 1024 * 1024

/**
 * Above this size, offer the save picker so the bytes land on disk once
 * instead of filling OPFS and then being copied again by a browser download.
 */
export const PICKER_MIN_BYTES = 256 * 1024 * 1024

/**
 * Above this size, ask the browser to make storage persistent before receiving
 * into OPFS.
 *
 * Not lower, because asking is not free: Firefox shows a permission prompt for
 * it, and a prompt to protect a transfer that finishes in two seconds is worse
 * than the eviction it prevents. Below this a transfer is short enough that
 * being interrupted *and* evicted is not a case worth spending a prompt on.
 */
export const PERSIST_MIN_BYTES = 128 * 1024 * 1024

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

/**
 * Signaling relays, pinned rather than left to Trystero's defaults.
 *
 * Trystero picks 5 of its 47 public relays by shuffling them with a seed
 * derived from the appId — so the choice is fixed for the whole app, not per
 * room. Measured from a browser, 8 of those 47 were unreachable and flit's
 * particular five contained four of them: damus.io answered 503, binaryrobot
 * 530, the Aachen mirror 502, and nostrdice closed the connection outright.
 * Pairing therefore rode on a single relay, and failed whenever that one relay
 * was busy — which is exactly the "first connection never works, start over
 * does" behaviour. Rejoining picked the same five, so retrying only helped by
 * chance.
 *
 * A handshake is not enough to earn a place here. Each relay below was checked
 * (2026-09-25) with the round trip signaling actually depends on: one socket
 * subscribes to a topic, a second publishes a signed ephemeral event to it — the
 * kind Trystero uses — and the first must receive it. Several relays that
 * answer a handshake refuse exactly that: ephemeral kinds blocked, proof of
 * work required, unregistered kinds rejected. relay.mostr.pub and
 * relay.froth.zone had since gone dark and were replaced.
 *
 * Every device on a build uses this same list, which is what guarantees two
 * devices share a relay. Relay operators come and go: `npm run check:signaling`
 * runs that check, and .github/workflows/signaling-health.yml runs it weekly.
 */
export const RELAY_URLS: readonly string[] = [
  'wss://purplerelay.com',
  'wss://nostr-01.yakihonne.com',
  'wss://relay.notoshi.win',
  'wss://x.kojira.io',
  'wss://nos.lol',
  'wss://nostr.data.haus',
  'wss://basspistol.org',
  'wss://bucket.coracle.social'
]
