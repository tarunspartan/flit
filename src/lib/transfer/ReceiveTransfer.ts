import {
  CHECKPOINT_INTERVAL_BYTES,
  CHECKPOINT_INTERVAL_MS,
  LIMITS,
  TIMEOUTS
} from '../core/config.ts'
import type {Bytes} from '../core/bytes.ts'
import {AppError, friendly, toAppError} from '../core/errors.ts'
import {ChunkTreeHasher} from '../integrity/hash.ts'
import {message, type ControlMessage, type TransferOffer} from '../protocol/messages.ts'
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
  /** Set while this download is accepted but waiting for the one ahead of it. */
  queuePosition: number | null = null
  /** Which drop this file arrived in, when the sender said. */
  readonly batchId: string | null
  error: AppError | null = null
  verified = false
  startedAt: number | null = null
  endedAt: number | null = null
  lastActivity = Date.now()
  capacity: CapacityCheck | null = null

  #link: PeerLink
  #onChange: () => void
  #prefs: StoragePreferences
  #hasher: ChunkTreeHasher
  #speed = new SpeedMeter()
  #store: ReceiverStore | null = null
  #blob: Blob | null = null
  #savedToDisk = false
  /** Kept so a re-announced completion can be answered without rehashing. */
  #contentHash: string | null = null

  #identity: {size: number; lastModified: number; chunkSize: number}
  #receivedBytes = 0
  /** Contiguous chunks written (may not yet be durable). */
  #contiguous = 0
  /** Contiguous chunks confirmed flushed — the only safe resume point. */
  #durable = 0
  #writeQueue: Promise<void> = Promise.resolve()
  #pendingBytes = 0
  #flowPaused = false
  #lastCheckpointAt = 0
  #bytesSinceCheckpoint = 0

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

    try {
      this.#store = await createReceiverStore(
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
      await this.#reject(appError.code === 'storage-full' ? 'no-storage' : 'no-storage', appError)
      return
    }

    this.startedAt = Date.now()
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
    this.#transition('TRANSFERRING')
    void this.#sendResumePoint()
  }

  /** Re-offers the completed file when the browser blocked the auto-download. */
  saveAgain(): void {
    if (this.#blob) triggerDownload(this.#blob, this.name)
  }

  /** The verified file, when it is not already written to a chosen location. */
  get received(): Blob | null {
    return this.#blob
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
        this.#fail(new AppError('protocol-violation', msg.detail ?? msg.code))
        void this.#store?.abort()
        break

      default:
        break
    }
  }

  handleChunk(index: number, payload: Bytes): void {
    if (this.state !== 'TRANSFERRING' && this.state !== 'PAUSED') return

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

    // Duplicates are expected after a resume and must not corrupt anything.
    if (this.#hasher.has(index)) return

    this.lastActivity = Date.now()
    this.#enqueueWrite(index, payload)
  }

  #enqueueWrite(index: number, payload: Bytes): void {
    this.#pendingBytes += payload.byteLength
    if (this.#pendingBytes >= WRITE_QUEUE_HIGH_WATER) this.#setFlow(true)

    this.#writeQueue = this.#writeQueue
      .then(async () => {
        const store = this.#store
        if (!store || isTerminal(this.state)) return
        await store.write(index * this.chunkSize, payload)
        await this.#hasher.add(index, payload)

        this.#receivedBytes += payload.byteLength
        this.#speed.record(payload.byteLength)
        this.#bytesSinceCheckpoint += payload.byteLength
        this.#contiguous = this.#hasher.contiguousCount(this.#contiguous)
        this.#onChange()
        await this.#maybeCheckpoint()
      })
      .catch((err: unknown) => {
        this.#onWriteFailure(err)
      })
      .finally(() => {
        this.#pendingBytes -= payload.byteLength
        if (this.#pendingBytes <= WRITE_QUEUE_LOW_WATER) this.#setFlow(false)
      })
  }

  #onWriteFailure(err: unknown): void {
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
   * (§73.4). It is also the point a resume would restart from.
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
    await this.#store.flush()
    this.#durable = this.#contiguous
    await this.#send(
      message({
        t: 'TRANSFER_CHECKPOINT',
        transferId: this.id,
        chunks: this.#durable,
        bytes: Math.min(this.size, this.#durable * this.chunkSize)
      })
    )
  }

  // ------------------------------------------------------------------- resume

  async #onResumeRequest(identity: {size: number; lastModified: number; chunkSize: number}): Promise<void> {
    if (isTerminal(this.state)) return

    // Never append bytes from a file that is no longer the one we started (§74.3).
    if (
      identity.size !== this.#identity.size ||
      identity.lastModified !== this.#identity.lastModified ||
      identity.chunkSize !== this.#identity.chunkSize
    ) {
      this.#fail(new AppError('resume-mismatch'))
      void this.#store?.abort()
      await this.#send(
        message({t: 'TRANSFER_ERROR', transferId: this.id, code: 'resume-mismatch'})
      )
      return
    }

    if (!this.#store) {
      // Interrupted before consent: ask the user again rather than auto-accepting.
      this.#transition('WAITING_FOR_ACCEPT')
      return
    }

    await this.#sendResumePoint()
  }

  async #sendResumePoint(): Promise<void> {
    // Anything above the durable checkpoint may not have reached disk, so it is
    // dropped and re-requested rather than assumed good.
    await this.#store?.flush().catch(() => {})
    this.#hasher.truncateTo(this.#durable)
    this.#contiguous = this.#durable
    this.#receivedBytes = Math.min(this.size, this.#durable * this.chunkSize)
    this.#speed.reset()
    this.#flowPaused = false
    if (this.state !== 'TRANSFERRING') this.#transition('TRANSFERRING')
    this.startedAt ??= Date.now()
    await this.#send(
      message({t: 'TRANSFER_ACCEPT', transferId: this.id, fromChunk: this.#durable})
    )
  }

  onPeerLost(): void {
    if (isTerminal(this.state) || this.state === 'WAITING_FOR_ACCEPT') return
    this.#speed.reset()
    this.#transition('RECONNECTING')
  }

  onPeerRestored(): void {
    // The sender drives resume negotiation; we answer its TRANSFER_RESUME.
    if (this.state === 'RECONNECTING') this.lastActivity = Date.now()
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

  checkStall(now = Date.now()): void {
    if (!['TRANSFERRING', 'RECONNECTING', 'VERIFYING'].includes(this.state)) return
    const limit =
      this.state === 'RECONNECTING' ? TIMEOUTS.reconnectWindowMs : TIMEOUTS.transferStallMs
    if (now - this.lastActivity > limit) {
      this.#fail(new AppError(this.state === 'RECONNECTING' ? 'connection-lost' : 'transfer-stalled'))
      void this.#store?.abort()
    }
  }

  // ------------------------------------------------------------- finalization

  async #onSenderComplete(expectedHash: string): Promise<void> {
    // Duplicate completions are expected: if the verdict was lost with the
    // connection, the sender re-announces and we answer again (§73.3).
    if (this.state === 'COMPLETED' && this.#contentHash) {
      await this.#send(
        message({
          t: 'TRANSFER_VERIFY',
          transferId: this.id,
          ok: this.#contentHash === expectedHash,
          contentHash: this.#contentHash
        })
      )
      return
    }
    if (isTerminal(this.state)) return
    this.#transition('VERIFYING')

    // Writes are async; let the queue drain before judging completeness.
    await this.#writeQueue.catch(() => {})
    if (isTerminal(this.state)) return

    if (!this.#hasher.complete) {
      // Gaps mean chunks were lost with the connection: ask for the rest
      // instead of failing the whole file.
      this.#transition('TRANSFERRING')
      await this.#maybeCheckpoint(true)
      await this.#sendResumePoint()
      return
    }

    let actualHash: string
    try {
      actualHash = await this.#hasher.root()
    } catch (err) {
      this.#fail(toAppError(err, 'integrity-failed'))
      void this.#store?.abort()
      return
    }

    this.#contentHash = actualHash
    const ok = actualHash === expectedHash
    await this.#send(
      message({t: 'TRANSFER_VERIFY', transferId: this.id, ok, contentHash: actualHash})
    )

    if (!ok) {
      // A file that failed verification is never handed to the user.
      this.#fail(new AppError('integrity-failed'))
      void this.#store?.abort()
      return
    }

    this.verified = true
    await this.#finalize()
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

  async #reject(
    reason: 'declined' | 'too-large' | 'no-storage' | 'busy',
    error: AppError
  ): Promise<void> {
    if (isTerminal(this.state)) return
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
      // The peer is gone; the reconnect path re-establishes state.
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
    return {
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
    }
  }
}

function sanitizeMime(input: string): string {
  return /^[\w.+-]+\/[\w.+-]+$/.test(input) ? input : 'application/octet-stream'
}
