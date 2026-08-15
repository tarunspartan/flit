import {CHUNK_SIZE, MAX_IN_FLIGHT_CHUNKS, TIMEOUTS} from '../core/config.ts'
import {AppError, friendly, toAppError} from '../core/errors.ts'
import {ChunkTreeHasher} from '../integrity/hash.ts'
import {encodeChunk} from '../protocol/frame.ts'
import {HASH_ALGORITHM, message, type ControlMessage} from '../protocol/messages.ts'
import {SpeedMeter} from '../utils/speed.ts'
import {FlowController} from './FlowController.ts'
import type {PeerLink} from './PeerLink.ts'
import {canTransition, isTerminal, type TransferState, type TransferView} from './states.ts'

export interface SendTransferOptions {
  id: string
  seq: number
  peerId: string
  peerName: string
  file: File
  relPath?: string
  link: PeerLink
  onChange: () => void
}

/**
 * The sending half of a transfer.
 *
 * Bytes are read from the File in bounded slices and never held whole in
 * memory. The receiver's checkpoints — not our own optimism — are what a resume
 * is based on.
 */
export class SendTransfer {
  readonly id: string
  readonly seq: number
  readonly direction = 'send' as const
  readonly peerId: string
  peerName: string
  readonly file: File
  readonly relPath: string | undefined
  readonly chunkSize = CHUNK_SIZE
  readonly totalChunks: number

  state: TransferState = 'QUEUED'
  /** Which dropped file this transfer is delivering. */
  sharedId = ''
  queuePosition: number | null = null
  error: AppError | null = null
  startedAt: number | null = null
  endedAt: number | null = null
  verified = false
  lastActivity = Date.now()

  #link: PeerLink
  #onChange: () => void
  #hasher: ChunkTreeHasher
  #flow = new FlowController(MAX_IN_FLIGHT_CHUNKS)
  #speed = new SpeedMeter()

  /** Next chunk index to dispatch. Rewound by a resume. */
  #next = 0
  #sentBytes = 0
  #ackedBytes = 0
  #pumping = false
  #pumpRequested = false
  /** True once the completion hash has been sent for the current send epoch. */
  #announced = false
  #pausedByUser = false
  #pausedByPeer = false
  #wake: (() => void) | null = null
  #identitySize: number
  #identityModified: number

  constructor(options: SendTransferOptions) {
    this.id = options.id
    this.seq = options.seq
    this.peerId = options.peerId
    this.peerName = options.peerName
    this.file = options.file
    this.relPath = options.relPath
    this.#link = options.link
    this.#onChange = options.onChange
    this.totalChunks = Math.ceil(options.file.size / this.chunkSize)
    this.#hasher = new ChunkTreeHasher(options.file.size, this.chunkSize, this.totalChunks)
    this.#identitySize = options.file.size
    this.#identityModified = options.file.lastModified
  }

  get bytesTransferred(): number {
    return this.#sentBytes
  }

  // ---------------------------------------------------------------- lifecycle

  /** Offers the file and waits for the receiver's consent. */
  async start(): Promise<void> {
    if (this.state !== 'QUEUED') return
    this.#transition('WAITING_FOR_ACCEPT')
    this.queuePosition = null
    try {
      await this.#link.sendControl(
        message({
          t: 'TRANSFER_OFFER',
          transferId: this.id,
          seq: this.seq,
          name: this.file.name,
          size: this.file.size,
          mimeType: this.file.type || 'application/octet-stream',
          lastModified: this.file.lastModified,
          chunkSize: this.chunkSize,
          totalChunks: this.totalChunks,
          hashAlgorithm: HASH_ALGORITHM,
          ...(this.relPath ? {relPath: this.relPath} : {})
        })
      )
    } catch (err) {
      this.#fail(toAppError(err, 'connection-lost'))
    }
  }

  handleMessage(msg: ControlMessage): void {
    this.lastActivity = Date.now()
    switch (msg.t) {
      case 'TRANSFER_ACCEPT':
        this.#onAccept(msg.fromChunk)
        break

      case 'TRANSFER_REJECT':
        this.#finishWith(
          'REJECTED',
          new AppError(msg.reason === 'too-large' ? 'too-large' : 'transfer-rejected', msg.reason)
        )
        break

      case 'TRANSFER_CHECKPOINT':
        // Trust the receiver's number over our own optimistic counter.
        this.#ackedBytes = Math.min(msg.bytes, this.file.size)
        this.#onChange()
        break

      case 'TRANSFER_FLOW':
        this.#pausedByPeer = msg.paused
        if (!msg.paused) this.#signal()
        this.#onChange()
        break

      case 'TRANSFER_PAUSE':
        this.#pausedByPeer = true
        this.#transition('PAUSED')
        break

      case 'TRANSFER_VERIFY':
        if (msg.ok) {
          this.verified = true
          this.#finishWith('COMPLETED', null)
        } else {
          this.#finishWith('FAILED', new AppError('integrity-failed'))
        }
        break

      case 'TRANSFER_CANCEL':
        this.#finishWith('CANCELLED', new AppError('transfer-cancelled', msg.reason))
        break

      case 'TRANSFER_ERROR':
        this.#fail(new AppError(errorCodeFrom(msg.code), msg.detail))
        break

      default:
        break
    }
  }

  #onAccept(fromChunk: number): void {
    if (isTerminal(this.state)) return
    if (fromChunk > this.totalChunks) return

    // A resume rewinds to what the receiver actually has on disk.
    this.#next = fromChunk
    this.#sentBytes = Math.min(fromChunk * this.chunkSize, this.file.size)
    this.#ackedBytes = this.#sentBytes
    // Digests above the resume point may be stale if the file was re-read.
    this.#hasher.truncateTo(fromChunk)
    this.#announced = false
    this.#pausedByPeer = false
    this.#speed.reset()
    this.startedAt ??= Date.now()
    this.#transition('TRANSFERRING')
    this.#signal()
    void this.#pump()
  }

  // ------------------------------------------------------------- user actions

  pause(): void {
    if (this.state !== 'TRANSFERRING') return
    this.#pausedByUser = true
    this.#transition('PAUSED')
    void this.#link.sendControl(message({t: 'TRANSFER_PAUSE', transferId: this.id})).catch(() => {})
  }

  resume(): void {
    if (this.state !== 'PAUSED') return
    this.#pausedByUser = false
    this.#pausedByPeer = false
    this.#speed.reset()
    this.#transition('TRANSFERRING')
    this.#signal()
    void this.#renegotiate()
  }

  cancel(notifyPeer = true): void {
    if (isTerminal(this.state)) return
    this.#finishWith('CANCELLED', new AppError('transfer-cancelled'))
    if (notifyPeer) {
      void this.#link
        .sendControl(message({t: 'TRANSFER_CANCEL', transferId: this.id, reason: 'user'}))
        .catch(() => {})
    }
  }

  // ------------------------------------------------------- connection changes

  onPeerLost(): void {
    if (isTerminal(this.state) || this.state === 'QUEUED') return
    this.#pausedByPeer = false
    this.#speed.reset()
    // Reachable from VERIFYING too: a drop between "all sent" and the verdict
    // must not strand the transfer.
    this.#transition('RECONNECTING')
  }

  /** Renegotiates from the receiver's checkpoint rather than restarting (§74.2). */
  onPeerRestored(): void {
    if (this.state !== 'RECONNECTING') return
    // Every byte was already sent and only the verification handshake was lost;
    // re-announcing is enough, and the receiver answers idempotently.
    if (this.#hasher.complete) void this.#announceComplete()
    else void this.#renegotiate()
  }

  async #renegotiate(): Promise<void> {
    if (isTerminal(this.state)) return
    try {
      await this.#link.sendControl(
        message({
          t: 'TRANSFER_RESUME',
          transferId: this.id,
          identity: {
            size: this.#identitySize,
            lastModified: this.#identityModified,
            chunkSize: this.chunkSize
          }
        })
      )
      // The receiver answers with TRANSFER_ACCEPT{fromChunk}, which restarts
      // the pump. If it never comes, the stall watchdog fails the transfer.
    } catch (err) {
      this.#fail(toAppError(err, 'connection-lost'))
    }
  }

  checkStall(now = Date.now()): void {
    // VERIFYING is included: waiting forever for a verdict is also a stall.
    if (!['TRANSFERRING', 'RECONNECTING', 'VERIFYING'].includes(this.state)) return
    const limit =
      this.state === 'RECONNECTING' ? TIMEOUTS.reconnectWindowMs : TIMEOUTS.transferStallMs
    if (now - this.lastActivity > limit) {
      this.#fail(new AppError(this.state === 'RECONNECTING' ? 'connection-lost' : 'transfer-stalled'))
    }
  }

  // -------------------------------------------------------------- the pump

  async #pump(): Promise<void> {
    // A resume can rewind #next while a pass is already draining. Recording the
    // request means the running pass makes another lap instead of the
    // "already pumping" guard swallowing the restart and stranding the transfer.
    this.#pumpRequested = true
    if (this.#pumping) return
    this.#pumping = true

    try {
      while (this.#pumpRequested) {
        this.#pumpRequested = false

        while (this.#next < this.totalChunks) {
          await this.#waitUntilRunnable()
          if (isTerminal(this.state)) return
          if (this.#blocked()) continue

          await this.#flow.acquire()
          if (isTerminal(this.state) || this.#blocked()) {
            this.#flow.release()
            continue
          }

          const index = this.#next++
          void this.#sendChunk(index).finally(() => this.#flow.release())
        }

        await this.#flow.drain()
        if (isTerminal(this.state) || this.state === 'RECONNECTING') continue

        // #announced keeps a second lap from re-announcing; a resume clears it.
        if (!this.#announced && this.#hasher.complete) await this.#announceComplete()
      }
    } finally {
      this.#pumping = false
    }
  }

  async #sendChunk(index: number): Promise<void> {
    const offset = index * this.chunkSize
    const length = Math.min(this.chunkSize, this.file.size - offset)
    try {
      const slice = this.file.slice(offset, offset + length)
      const payload = new Uint8Array(await slice.arrayBuffer())
      if (payload.byteLength !== length) throw new AppError('file-changed')

      await this.#hasher.add(index, payload)
      await this.#link.sendChunk(encodeChunk(this.seq, index, payload))

      this.#sentBytes = Math.min(this.file.size, this.#sentBytes + length)
      this.#speed.record(length)
      this.lastActivity = Date.now()
      this.#onChange()
    } catch (err) {
      this.#onChunkFailure(index, err)
    }
  }

  #onChunkFailure(index: number, err: unknown): void {
    if (isTerminal(this.state)) return
    const appError = toAppError(err, 'connection-lost')

    // A file that can no longer be read will not fix itself on reconnect.
    if (appError.code === 'file-changed' || appError.code === 'file-unreadable') {
      this.#fail(appError)
      return
    }

    // Rewind so the failed chunk is resent once the link is back.
    this.#next = Math.min(this.#next, index)
    this.#sentBytes = Math.min(this.#sentBytes, index * this.chunkSize)
    if (this.state === 'TRANSFERRING') this.#transition('RECONNECTING')
  }

  async #announceComplete(): Promise<void> {
    try {
      const contentHash = await this.#hasher.root()
      this.#announced = true
      this.#transition('VERIFYING')
      await this.#link.sendControl(
        message({t: 'TRANSFER_COMPLETE', transferId: this.id, contentHash})
      )
      this.lastActivity = Date.now()
    } catch (err) {
      this.#fail(toAppError(err, 'connection-lost'))
    }
  }

  // ---------------------------------------------------------------- internals

  #blocked(): boolean {
    return (
      this.#pausedByUser ||
      this.#pausedByPeer ||
      this.state === 'RECONNECTING' ||
      this.state === 'PAUSED' ||
      !this.#link.isConnected()
    )
  }

  async #waitUntilRunnable(): Promise<void> {
    while (this.#blocked() && !isTerminal(this.state)) {
      await new Promise<void>(resolve => {
        this.#wake = resolve
      })
    }
  }

  #signal(): void {
    const wake = this.#wake
    this.#wake = null
    wake?.()
  }

  #transition(next: TransferState): void {
    if (this.state === next) return
    if (!canTransition(this.state, next)) return
    this.state = next
    if (isTerminal(next)) this.endedAt = Date.now()
    this.#signal()
    this.#onChange()
  }

  #finishWith(state: TransferState, error: AppError | null): void {
    if (isTerminal(this.state)) return
    this.error = error
    // Terminal states are reachable from anywhere; bypass the table so a
    // cancel or reject is never swallowed.
    this.state = state
    this.endedAt = Date.now()
    this.#flow.abort()
    this.#signal()
    this.#onChange()
  }

  #fail(error: AppError): void {
    this.#finishWith('FAILED', error)
  }

  view(): TransferView {
    const remaining = Math.max(0, this.file.size - this.#sentBytes)
    const running = this.state === 'TRANSFERRING'
    return {
      id: this.id,
      direction: 'send',
      peerId: this.peerId,
      peerName: this.peerName,
      state: this.state,
      name: this.file.name,
      size: this.file.size,
      mimeType: this.file.type || 'application/octet-stream',
      bytesTransferred: this.#sentBytes,
      progress: this.file.size === 0 ? 1 : this.#sentBytes / this.file.size,
      speed: running ? this.#speed.rate() : null,
      etaSeconds: running ? this.#speed.eta(remaining) : null,
      queuePosition: this.queuePosition,
      error: this.error ? {code: this.error.code, ...friendly(this.error)} : null,
      verified: this.verified,
      storageKind: null,
      savedToDisk: false,
      downloadReady: false,
      storageWarning: null,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      canRetry: this.state === 'FAILED' || this.state === 'CANCELLED',
      canPause: this.state === 'TRANSFERRING' || this.state === 'PAUSED',
      canCancel: !isTerminal(this.state)
    }
  }

  /** Bytes the receiver has confirmed, for diagnostics. */
  get acknowledgedBytes(): number {
    return this.#ackedBytes
  }
}

function errorCodeFrom(code: string): AppError['code'] {
  const known = [
    'storage-full',
    'storage-unavailable',
    'integrity-failed',
    'resume-mismatch',
    'too-large',
    'finalize-failed'
  ] as const
  return (known as readonly string[]).includes(code) ? (code as AppError['code']) : 'protocol-violation'
}
