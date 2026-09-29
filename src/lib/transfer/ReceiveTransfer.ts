import {CHECKPOINT_INTERVAL_BYTES, CHECKPOINT_INTERVAL_MS, LIMITS, TIMEOUTS} from '../core/config.ts'
import type {Bytes} from '../core/bytes.ts'
import {AppError, codeFromPeer, friendly, toAppError} from '../core/errors.ts'
import {ChunkTreeHasher, sha256} from '../integrity/hash.ts'
import {
  MAX_MISSING_RANGES,
  message,
  type ControlMessage,
  type TransferOffer,
  type TransferReject
} from '../protocol/messages.ts'
import {
  canChooseLocation,
  createReceiverStore,
  triggerDownload,
  usesChosenLocation,
  type ReceiverStore,
  type StoragePreferences
} from '../storage/index.ts'
import {checkCapacity, type CapacityCheck} from '../storage/estimate.ts'
import type {StoreKind} from '../storage/types.ts'
import {sanitizeFilename, sanitizeRelativePath} from '../utils/filename.ts'
import {formatBytes} from '../utils/format.ts'
import {SpeedMeter} from '../utils/speed.ts'
import {keepIfSame} from '../utils/stable.ts'
import type {PeerLink} from './PeerLink.ts'
import {canTransition, isTerminal, type TransferState, type TransferView} from './states.ts'

/** Receiver write queue bounds — a safety net above the sender's own window. */
const WRITE_QUEUE_HIGH_WATER = 8 * 1024 * 1024
const WRITE_QUEUE_LOW_WATER = 2 * 1024 * 1024

export interface ReceiveTransferOptions {
  offer: TransferOffer
  peerId: string
  peerName: string
  link: PeerLink
  onChange: () => void
  storagePrefs: StoragePreferences
  /** Names already used this session, so duplicates don't overwrite. */
  reserveName: (name: string) => string
}

/**
 * The receiving half of a transfer.
 *
 * Chunks are hashed and streamed to a storage tier as they arrive; nothing is
 * shown to the user as a file until every chunk is present, the content hash
 * matches, and finalization succeeds (§78.1).
 *
 * Every chunk that has been written is kept. Whenever more are needed — after a
 * drop, after a pause, when the sender has gone quiet — the receiver flushes and
 * says exactly which chunks it still lacks, and the sender sends those.
 */
export class ReceiveTransfer {
  readonly id: string
  readonly seq: number
  readonly direction = 'receive' as const
  readonly peerId: string
  peerName: string
  readonly name: string
  readonly relPath: string[]
  readonly size: number
  readonly mimeType: string
  readonly chunkSize: number
  readonly totalChunks: number

  state: TransferState = 'WAITING_FOR_ACCEPT'
  /** Set while this download is accepted but waiting for a free slot. */
  queuePosition: number | null = null
  /** Which drop this file arrived in, when the sender said. */
  readonly batchId: string | null
  error: AppError | null = null
  verified = false
  startedAt: number | null = null
  endedAt: number | null = null
  lastActivity = Date.now()
  capacity: CapacityCheck | null = null

  /**
   * When the peer was *first* seen to go, cleared once bytes flow again.
   *
   * The reconnect window used to be measured from `lastActivity`, which every
   * reappearance refreshed — so a peer that flapped kept resetting the clock
   * and the transfer could sit in RECONNECTING indefinitely instead of failing.
   * Measuring from the first sign of trouble bounds it however often the link
   * bounces.
   */
  #lostAt: number | null = null

  #link: PeerLink
  #onChange: () => void
  #prefs: StoragePreferences
  #hasher: ChunkTreeHasher
  #speed = new SpeedMeter()
  #view: TransferView | null = null
  #store: ReceiverStore | null = null
  #blob: Blob | null = null
  #savedToDisk = false
  /** Kept so a re-announced completion can be answered without rehashing. */
  #contentHash: string | null = null
  /** What we answered an offer with, so a repeated offer gets the same answer. */
  #rejectReason: TransferReject['reason'] = 'declined'

  #identity: {size: number; lastModified: number; chunkSize: number}
  #receivedBytes = 0
  /** Contiguous chunks written from index 0 — what a checkpoint reports. */
  #contiguous = 0
  /** Chunks accepted into the write queue and not yet recorded as present. */
  #pending = new Set<number>()
  #writeQueue: Promise<void> = Promise.resolve()
  #pendingBytes = 0
  #flowPaused = false
  #lastCheckpointAt = 0
  #bytesSinceCheckpoint = 0
  /** When a chunk last arrived or we last asked for more, for the retry clock. */
  #quietSince = 0
  /** The verification in progress, so an overlapping completion joins it. */
  #verifying: Promise<void> | null = null
  /**
   * True while the work in hand is ours — draining writes, hashing, saving.
   * The stall watchdog asks whether the *peer* has gone quiet; a multi-gigabyte
   * save that takes a minute is not the peer's silence.
   */
  #busyLocally = false

  constructor(options: ReceiveTransferOptions) {
    const {offer} = options
    this.id = offer.transferId
    this.seq = offer.seq
    this.peerId = options.peerId
    this.peerName = options.peerName
    this.size = offer.size
    this.chunkSize = offer.chunkSize
    this.totalChunks = offer.totalChunks
    this.mimeType = sanitizeMime(offer.mimeType)
    this.relPath = sanitizeRelativePath(offer.relPath)
    this.batchId = offer.batchId ?? null
    // Untrusted: normalized, stripped of path components, then de-duplicated.
    this.name = options.reserveName(sanitizeFilename(offer.name))
    this.#identity = {
      size: offer.size,
      lastModified: offer.lastModified,
      chunkSize: offer.chunkSize
    }
    this.#link = options.link
    this.#onChange = options.onChange
    this.#prefs = options.storagePrefs
    this.#hasher = new ChunkTreeHasher(offer.size, offer.chunkSize, offer.totalChunks)
  }

  /** Storage advice shown next to Accept/Reject (§66.9). */
  async prepare(): Promise<void> {
    // Only judged against the origin quota when the bytes will actually land
    // there. A file big enough for the save picker streams to real disk, where
    // the quota means nothing — checking it anyway warned about a 2.6 GB file
    // against a ~3 GB *browser allowance* on a drive with far more free.
    const quotaApplies = !usesChosenLocation(this.size, this.#prefs)
    this.capacity = await checkCapacity(this.size, quotaApplies)
    this.#onChange()
  }

  // ------------------------------------------------------------- user actions

  /** Called from the Accept click, so a save picker is allowed to open. */
  async accept(): Promise<void> {
    if (this.state !== 'WAITING_FOR_ACCEPT') return

    if (this.size > LIMITS.maxFileSize) {
      await this.#reject('too-large', new AppError('too-large'))
      return
    }

    let store: ReceiverStore
    try {
      store = await createReceiverStore(
        {filename: this.name, size: this.size, mimeType: this.mimeType, allowPicker: true},
        this.#prefs
      )
    } catch (err) {
      const appError = toAppError(err, 'storage-unavailable')
      // Closing the save dialog means "not this file, not now". It is neither a
      // failure to report nor a rejection to send the other device: the
      // transfer stays exactly where it was, so the Download button comes back
      // and it can be taken later, with a location, or not at all.
      if (appError.code === 'save-cancelled') {
        this.#onChange()
        return
      }
      await this.#reject('no-storage', appError)
      return
    }

    // The sender may have cancelled while the save dialog was open.
    if (this.state !== 'WAITING_FOR_ACCEPT') {
      await store.abort()
      return
    }

    this.#store = store
    this.startedAt = Date.now()
    this.#quietSince = Date.now()
    // The stall clock starts now, not when the offer arrived. Left at the
    // offer's time, a file accepted more than a stall window later failed as
    // "nothing arrived" within seconds — before its sender, still busy with
    // the file ahead of it in the same batch, had sent it a single chunk.
    this.lastActivity = Date.now()
    this.#transition('TRANSFERRING')
    await this.#send(message({t: 'TRANSFER_ACCEPT', transferId: this.id, fromChunk: 0}))
  }

  async reject(): Promise<void> {
    await this.#reject('declined', new AppError('transfer-rejected'))
  }

  cancel(notifyPeer = true): void {
    if (isTerminal(this.state)) return
    this.#finishWith('CANCELLED', new AppError('transfer-cancelled'))
    void this.#store?.abort()
    if (notifyPeer) {
      void this.#send(message({t: 'TRANSFER_CANCEL', transferId: this.id, reason: 'user'}))
    }
  }

  pause(): void {
    if (this.state !== 'TRANSFERRING') return
    this.#transition('PAUSED')
    void this.#send(message({t: 'TRANSFER_PAUSE', transferId: this.id}))
  }

  resume(): void {
    if (this.state !== 'PAUSED') return
    void this.#requestMissing()
  }

  /** Re-offers the completed file when the browser blocked the auto-download. */
  saveAgain(): void {
    if (this.#blob) triggerDownload(this.#blob, this.name)
  }

  /** The verified file, when it is not already written to a chosen location. */
  get received(): Blob | null {
    return this.#blob
  }

  /**
   * Lets go of everything this transfer holds on disk or in memory. Called once
   * it leaves the list; until then the finished file stays for "Save again".
   */
  dispose(): void {
    this.cancel(false)
    this.#blob = null
    const store = this.#store
    this.#store = null
    void store?.release()
  }

  // ------------------------------------------------------------------ inbound

  handleMessage(msg: ControlMessage): void {
    this.lastActivity = Date.now()
    switch (msg.t) {
      case 'TRANSFER_RESUME':
        void this.#onResumeRequest(msg.identity)
        break

      case 'TRANSFER_COMPLETE':
        void this.#onSenderComplete(msg.contentHash)
        break

      case 'TRANSFER_CANCEL':
        if (!isTerminal(this.state)) {
          this.#finishWith('CANCELLED', new AppError('transfer-cancelled', msg.reason))
          void this.#store?.abort()
        }
        break

      case 'TRANSFER_PAUSE':
        if (this.state === 'TRANSFERRING') this.#transition('PAUSED')
        break

      case 'TRANSFER_ERROR':
        this.#fail(new AppError(codeFromPeer(msg.code), msg.detail))
        void this.#store?.abort()
        break

      default:
        break
    }
  }

  /**
   * The sender offered this file again, which means it never heard our answer —
   * the connection took it. Answer again, whatever the answer was.
   */
  onOfferRepeated(): void {
    switch (this.state) {
      case 'REJECTED':
        void this.#send(message({t: 'TRANSFER_REJECT', transferId: this.id, reason: this.#rejectReason}))
        break
      case 'CANCELLED':
        void this.#send(message({t: 'TRANSFER_CANCEL', transferId: this.id, reason: 'user'}))
        break
      case 'FAILED':
        void this.#send(
          message({t: 'TRANSFER_ERROR', transferId: this.id, code: this.error?.code ?? 'protocol-violation'})
        )
        break
      case 'COMPLETED':
        void this.#sendVerdict(true)
        break
      case 'TRANSFERRING':
      case 'RECONNECTING':
        // We said yes and the sender never heard it.
        void this.#requestMissing()
        break
      default:
        // Still undecided, queued, paused or verifying: nothing to repeat.
        break
    }
  }

  handleChunk(index: number, payload: Bytes): void {
    // Accepted in any live state once consent has opened a store: a chunk
    // landing during RECONNECTING or VERIFYING is a real chunk, and turning it
    // away only means asking for it again.
    if (!this.#store || isTerminal(this.state)) return

    // Every chunk is checked against what the offer promised (§10).
    if (index < 0 || index >= this.totalChunks) {
      this.#protocolViolation(`chunk index ${index} outside 0..${this.totalChunks - 1}`)
      return
    }
    const expected = Math.min(this.chunkSize, this.size - index * this.chunkSize)
    if (payload.byteLength !== expected) {
      this.#protocolViolation(`chunk ${index} was ${payload.byteLength}B, expected ${expected}B`)
      return
    }

    // A chunk landing is the only unambiguous evidence the link is working
    // again — asking to resume is not, because the request itself can fail into
    // a dead link. So this is what ends the reconnect window.
    this.lastActivity = Date.now()
    this.#quietSince = this.lastActivity
    this.#lostAt = null

    // Duplicates are expected after a resume and must not corrupt anything.
    if (this.#hasher.has(index) || this.#pending.has(index)) return
    this.#enqueueWrite(this.#store, index, payload)
  }

  #enqueueWrite(store: ReceiverStore, index: number, payload: Bytes): void {
    // Read now: a store may take ownership of the buffer, after which the view
    // reports a length of zero.
    const length = payload.byteLength
    this.#pending.add(index)
    this.#pendingBytes += length
    if (this.#pendingBytes >= WRITE_QUEUE_HIGH_WATER) this.#setFlow(true)

    // Started here rather than after the write: Web Crypto copies its input as
    // it is called, so hashing overlaps the disk write and leaves the store
    // free to take the buffer without a copy of its own.
    const digest = sha256(payload)

    this.#writeQueue = this.#writeQueue
      .then(async () => {
        if (isTerminal(this.state)) return
        await store.write(index * this.chunkSize, payload)
        this.#hasher.setDigest(index, await digest)

        this.#receivedBytes += length
        this.#speed.record(length)
        this.#bytesSinceCheckpoint += length
        this.#contiguous = this.#hasher.contiguousCount(this.#contiguous)
        // Our own progress counts as life: while the disk catches up the sender
        // is rightly holding back, and that is not a stall.
        this.lastActivity = Date.now()
        this.#onChange()
        await this.#maybeCheckpoint()
      })
      .catch((err: unknown) => {
        this.#onWriteFailure(err)
      })
      .finally(() => {
        this.#pending.delete(index)
        this.#pendingBytes -= length
        if (this.#pendingBytes <= WRITE_QUEUE_LOW_WATER) this.#setFlow(false)
      })
  }

  #onWriteFailure(err: unknown): void {
    if (isTerminal(this.state)) return
    const appError = toAppError(err, 'finalize-failed')
    this.#fail(appError)
    void this.#store?.abort()
    void this.#send(
      message({
        t: 'TRANSFER_ERROR',
        transferId: this.id,
        code: appError.code,
        detail: appError.detail?.slice(0, 500)
      })
    )
  }

  #setFlow(paused: boolean): void {
    if (this.#flowPaused === paused) return
    this.#flowPaused = paused
    void this.#send(message({t: 'TRANSFER_FLOW', transferId: this.id, paused}))
  }

  /**
   * A checkpoint claims durability, so it is only sent after a real flush
   * (§73.4).
   */
  async #maybeCheckpoint(force = false): Promise<void> {
    const now = Date.now()
    const due =
      force ||
      this.#bytesSinceCheckpoint >= CHECKPOINT_INTERVAL_BYTES ||
      (this.#bytesSinceCheckpoint > 0 && now - this.#lastCheckpointAt >= CHECKPOINT_INTERVAL_MS)
    if (!due || !this.#store) return

    this.#lastCheckpointAt = now
    this.#bytesSinceCheckpoint = 0
    const chunks = this.#contiguous
    await this.#store.flush()
    await this.#send(
      message({
        t: 'TRANSFER_CHECKPOINT',
        transferId: this.id,
        chunks,
        bytes: Math.min(this.size, chunks * this.chunkSize)
      })
    )
  }

  // ------------------------------------------------------------------- resume

  async #onResumeRequest(identity: {size: number; lastModified: number; chunkSize: number}): Promise<void> {
    if (this.state === 'COMPLETED') {
      // The sender lost our verdict along with the connection.
      await this.#sendVerdict(true)
      return
    }
    if (isTerminal(this.state)) return

    // Never append bytes from a file that is no longer the one we started (§74.3).
    if (
      identity.size !== this.#identity.size ||
      identity.lastModified !== this.#identity.lastModified ||
      identity.chunkSize !== this.#identity.chunkSize
    ) {
      this.#fail(new AppError('resume-mismatch'))
      void this.#store?.abort()
      await this.#send(message({t: 'TRANSFER_ERROR', transferId: this.id, code: 'resume-mismatch'}))
      return
    }

    // No store means consent never happened: the offer still stands, and
    // nothing is resumed without the user saying yes.
    if (!this.#store) return
    await this.#requestMissing()
  }

  /**
   * Asks for exactly the chunks still missing — the whole negotiation, whether
   * starting over after a drop, after a pause, or after gaps at completion.
   *
   * Everything already written is kept: it is flushed first, which makes it as
   * safe to resume from as a checkpoint. Only chunks neither present nor
   * already queued for writing are requested.
   */
  async #requestMissing(): Promise<void> {
    const store = this.#store
    if (!store || isTerminal(this.state)) return
    this.#quietSince = Date.now()
    await store.flush().catch(() => {})
    if (isTerminal(this.state)) return

    const missing = this.#hasher.missingRanges(MAX_MISSING_RANGES, index => this.#pending.has(index))
    this.#speed.reset()
    this.#transition('TRANSFERRING')
    this.startedAt ??= Date.now()
    // An ACCEPT lifts the sender's flow pause, so ours is re-raised right after
    // it if the disk is still behind.
    this.#flowPaused = false
    await this.#send(
      message({
        t: 'TRANSFER_ACCEPT',
        transferId: this.id,
        fromChunk: missing[0]?.[0] ?? this.totalChunks,
        missing
      })
    )
    if (this.#pendingBytes >= WRITE_QUEUE_HIGH_WATER) this.#setFlow(true)
  }

  onPeerLost(): void {
    if (isTerminal(this.state) || this.state === 'WAITING_FOR_ACCEPT' || this.state === 'PAUSED') return
    this.#speed.reset()
    this.#lostAt ??= Date.now()
    this.#transition('RECONNECTING')
  }

  /**
   * Either end may restart a transfer.
   *
   * The sender still drives resume when *it* saw the drop. But a drop is
   * routinely noticed by only one side — the other's connection can sit in the
   * roster looking healthy — and when that side was the sender, nobody ever
   * sent `TRANSFER_RESUME` and the receiver waited for a message that could not
   * arrive. So the end that noticed says so, whichever end that is.
   */
  onPeerRestored(): void {
    if (this.state !== 'RECONNECTING') return
    this.lastActivity = Date.now()
    void this.#requestMissing()
  }

  /**
   * Forgives time this page was not running.
   *
   * The stall watchdog measures wall-clock silence, which is only evidence
   * about the transfer while the page is actually executing. A phone that
   * locks, a laptop that sleeps or a backgrounded tab freezes everything —
   * and on waking, `now - lastActivity` is enormous through no fault of the
   * link, so the very first tick after resuming condemned a transfer that was
   * still perfectly alive. Sliding the marker forward gives it the full stall
   * window to prove itself, starting from when we could observe it again.
   */
  creditFrozen(ms: number): void {
    if (isTerminal(this.state)) return
    this.lastActivity = Math.min(Date.now(), this.lastActivity + ms)
  }

  /** Periodic upkeep: ask again if the sender has gone quiet, then check for a stall. */
  tick(now = Date.now()): void {
    this.#retry(now)
    this.checkStall(now)
  }

  /**
   * Nudges a sender that has gone quiet.
   *
   * Our ACCEPT, or the FLOW that lifted a pause, may have been lost; the
   * sender may have lost chunks we never saw. Asking for what is missing
   * covers all three, and is harmless if the sender was merely slow.
   */
  #retry(now: number): void {
    if (!this.#store || this.#busyLocally || !this.#link.isConnected()) return
    if (this.state !== 'TRANSFERRING' && this.state !== 'RECONNECTING') return
    // A silence we asked for with our own flow pause is not a lost message.
    if (this.state === 'TRANSFERRING' && this.#flowPaused) return
    if (now - this.#quietSince < TIMEOUTS.retryMs) return
    void this.#requestMissing()
  }

  checkStall(now = Date.now()): void {
    if (this.#busyLocally) return
    if (!['TRANSFERRING', 'RECONNECTING', 'VERIFYING'].includes(this.state)) return
    const reconnecting = this.state === 'RECONNECTING'
    const limit = reconnecting ? TIMEOUTS.reconnectWindowMs : TIMEOUTS.transferStallMs
    // While reconnecting, measure from the first drop rather than the last sign
    // of life, so a flapping peer cannot hold the transfer open forever.
    const since = reconnecting ? (this.#lostAt ?? this.lastActivity) : this.lastActivity
    if (now - since > limit) {
      const error = new AppError(reconnecting ? 'connection-lost' : 'transfer-stalled')
      this.#fail(error)
      void this.#store?.abort()
      // Say so, or the sender — which may have sent every byte — sits at 100%
      // waiting on a receiver that has already given up.
      void this.#send(message({t: 'TRANSFER_ERROR', transferId: this.id, code: error.code}))
    }
  }

  // ------------------------------------------------------------- finalization

  async #onSenderComplete(expectedHash: string): Promise<void> {
    // Duplicate completions are expected: if the verdict was lost with the
    // connection, the sender re-announces and we answer again (§73.3).
    if (this.state === 'COMPLETED' && this.#contentHash) {
      await this.#sendVerdict(this.#contentHash === expectedHash)
      return
    }
    // A completion for a file nobody accepted is ignored — there is nothing to
    // verify, and no consent to finish without.
    if (isTerminal(this.state) || !this.#store) return
    // One verification at a time. A second completion arriving while the first
    // is still draining used to run the whole thing again — and finalize, and
    // download, the file twice.
    this.#verifying ??= this.#verify(expectedHash).finally(() => {
      this.#verifying = null
    })
    await this.#verifying
  }

  async #verify(expectedHash: string): Promise<void> {
    this.#busyLocally = true
    try {
      this.#transition('VERIFYING')

      // Writes are async; let the queue drain before judging completeness.
      // Looped, because a chunk that lands meanwhile extends the queue.
      let queue: Promise<void>
      do {
        queue = this.#writeQueue
        await queue
      } while (queue !== this.#writeQueue)
      if (isTerminal(this.state)) return

      if (!this.#hasher.complete) {
        // Gaps mean chunks were lost on the way: ask for exactly those
        // instead of failing the whole file.
        this.#busyLocally = false
        await this.#requestMissing()
        return
      }

      const actualHash = await this.#hasher.root()
      this.#contentHash = actualHash
      const ok = actualHash === expectedHash
      await this.#sendVerdict(ok)

      if (!ok) {
        // A file that failed verification is never handed to the user.
        this.#fail(new AppError('integrity-failed'))
        void this.#store?.abort()
        return
      }

      this.verified = true
      await this.#finalize()
    } catch (err) {
      this.#fail(toAppError(err, 'integrity-failed'))
      void this.#store?.abort()
    } finally {
      this.#busyLocally = false
    }
  }

  async #sendVerdict(ok: boolean): Promise<void> {
    if (!this.#contentHash) return
    await this.#send(
      message({t: 'TRANSFER_VERIFY', transferId: this.id, ok, contentHash: this.#contentHash})
    )
  }

  async #finalize(): Promise<void> {
    const store = this.#store
    if (!store) {
      this.#fail(new AppError('finalize-failed', 'no storage backend'))
      return
    }
    try {
      const result = await store.finalize()
      this.#savedToDisk = result.saved
      if (result.blob) {
        this.#blob = result.blob
        // Best effort: some mobile browsers only allow this inside a gesture,
        // which is why the UI always offers a Save button as well.
        triggerDownload(result.blob, this.name)
      }
      this.#receivedBytes = this.size
      this.#finishWith('COMPLETED', null)
    } catch (err) {
      // All bytes arrived but saving failed — a distinct state from a network
      // failure, and the message says so (§78.3).
      this.#fail(toAppError(err, 'finalize-failed'))
    }
  }

  // ---------------------------------------------------------------- internals

  async #reject(reason: TransferReject['reason'], error: AppError): Promise<void> {
    if (isTerminal(this.state)) return
    this.#rejectReason = reason
    this.#finishWith('REJECTED', error)
    await this.#send(message({t: 'TRANSFER_REJECT', transferId: this.id, reason}))
  }

  #protocolViolation(detail: string): void {
    this.#fail(new AppError('protocol-violation', detail))
    void this.#store?.abort()
    void this.#send(
      message({t: 'TRANSFER_ERROR', transferId: this.id, code: 'protocol-violation', detail})
    )
  }

  async #send(msg: ControlMessage): Promise<void> {
    try {
      await this.#link.sendControl(msg)
    } catch {
      // The peer is gone for now; the retry and reconnect paths re-establish state.
    }
  }

  #transition(next: TransferState): void {
    if (this.state === next) return
    if (!canTransition(this.state, next)) return
    this.state = next
    if (isTerminal(next)) this.endedAt = Date.now()
    this.#onChange()
  }

  #finishWith(state: TransferState, error: AppError | null): void {
    if (isTerminal(this.state)) return
    this.error = error
    this.state = state
    this.endedAt = Date.now()
    this.#onChange()
  }

  #fail(error: AppError): void {
    this.#finishWith('FAILED', error)
  }

  /** Warns *before* a huge transfer starts rather than after (§66.9). */
  #storageWarning(): string | null {
    const capacity = this.capacity
    if (!capacity || this.state !== 'WAITING_FOR_ACCEPT') return null
    if (capacity.verdict !== 'insufficient' && capacity.verdict !== 'tight') return null
    const free = capacity.available === null ? 'unknown' : formatBytes(capacity.available)
    const tight = capacity.verdict === 'tight'

    // Named for what the number actually is — the storage this browser allows
    // this site, not free space on the disk. Calling it "room on this device"
    // sent people to check a drive that was never the constraint.
    //
    // Split by whether anything can be done about it. Where the save picker
    // exists the ceiling is optional and the message says which setting lifts
    // it; where it does not, the ceiling is real and pretending otherwise
    // would send someone hunting for a button that is not there.
    if (canChooseLocation()) {
      return tight
        ? `This will use most of the ${free} of storage this browser allows here. Turn on "Always choose where to save" in Settings to write straight to disk instead.`
        : `Bigger than the ${free} of storage this browser allows here. Turn on "Always choose where to save" in Settings to write straight to disk instead.`
    }
    return tight
      ? `This will use most of the ${free} this browser allows this site to store.`
      : `Bigger than the ${free} this browser allows this site to store, and this browser cannot save straight to disk.`
  }

  view(): TransferView {
    const running = this.state === 'TRANSFERRING'
    const remaining = Math.max(0, this.size - this.#receivedBytes)
    this.#view = keepIfSame<TransferView>(this.#view, {
      id: this.id,
      direction: 'receive',
      peerId: this.peerId,
      peerName: this.peerName,
      state: this.state,
      name: this.name,
      size: this.size,
      mimeType: this.mimeType,
      bytesTransferred: this.#receivedBytes,
      progress: this.size === 0 ? 1 : this.#receivedBytes / this.size,
      speed: running ? this.#speed.rate() : null,
      etaSeconds: running ? this.#speed.eta(remaining) : null,
      queuePosition: this.queuePosition,
      batchId: this.batchId,
      error: this.error ? {code: this.error.code, ...friendly(this.error)} : null,
      verified: this.verified,
      storageKind: (this.#store?.kind ?? null) as StoreKind | null,
      savedToDisk: this.#savedToDisk,
      downloadReady: this.#blob !== null,
      storageWarning: this.#storageWarning(),
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      canRetry: false,
      canPause: this.state === 'TRANSFERRING' || this.state === 'PAUSED',
      canCancel: !isTerminal(this.state)
    })
    return this.#view
  }
}

function sanitizeMime(input: string): string {
  return /^[\w.+-]+\/[\w.+-]+$/.test(input) ? input : 'application/octet-stream'
}
