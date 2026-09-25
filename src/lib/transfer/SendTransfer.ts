import type {Bytes} from '../core/bytes.ts'
import {CHUNK_SIZE, MAX_IN_FLIGHT_CHUNKS, TIMEOUTS} from '../core/config.ts'
import {AppError, codeFromPeer, friendly, readFailure} from '../core/errors.ts'
import {ChunkTreeHasher} from '../integrity/hash.ts'
import {encodeChunk} from '../protocol/frame.ts'
import {
  HASH_ALGORITHM,
  MAX_MISSING_RANGES,
  message,
  type ChunkRange,
  type ControlMessage
} from '../protocol/messages.ts'
import {SpeedMeter} from '../utils/speed.ts'
import {keepIfSame} from '../utils/stable.ts'
import {ChunkPlan} from './ChunkPlan.ts'
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
  batchId?: string
  link: PeerLink
  onChange: () => void
  /** Defaults to CHUNK_SIZE; smaller when the link cannot carry that per message. */
  chunkSize?: number
  /**
   * Chunk digests for this file at this chunk size. Shared by every transfer
   * of one dropped file, so a room of eight hashes the file once, not seven
   * times. Safe to share because a File's bytes cannot change under it: a
   * browser refuses to read one that changed on disk.
   */
  hasher?: ChunkTreeHasher
}

/**
 * The sending half of a transfer.
 *
 * Bytes are read from the File in bounded slices and never held whole in
 * memory. What gets sent is decided by the receiver: each TRANSFER_ACCEPT says
 * exactly which chunks it still lacks, and that — not our own optimism — is
 * what a resume is based on.
 */
export class SendTransfer {
  readonly id: string
  readonly seq: number
  readonly direction = 'send' as const
  readonly peerId: string
  peerName: string
  readonly file: File
  readonly relPath: string | undefined
  readonly batchId: string | undefined
  readonly chunkSize: number
  readonly totalChunks: number
  /** The digests this transfer uses — possibly shared with its siblings. */
  readonly hasher: ChunkTreeHasher

  state: TransferState = 'QUEUED'
  /** Which dropped file this transfer is delivering. */
  sharedId = ''
  queuePosition: number | null = null
  error: AppError | null = null
  startedAt: number | null = null
  endedAt: number | null = null
  verified = false
  lastActivity = Date.now()

  /**
   * When the peer was *first* seen to go, cleared once the transfer restarts.
   * The reconnect window is measured from here rather than from `lastActivity`,
   * which every reappearance refreshed — a flapping peer could otherwise hold
   * the transfer in RECONNECTING indefinitely instead of failing.
   */
  #lostAt: number | null = null

  #link: PeerLink
  #onChange: () => void
  #flow = new FlowController(MAX_IN_FLIGHT_CHUNKS)
  #speed = new SpeedMeter()
  #view: TransferView | null = null

  /** What the receiver still needs. Replaced wholesale by every ACCEPT. */
  #plan = ChunkPlan.none()
  /**
   * Chunks handed to the current connection. The data path is reliable and
   * ordered, so while that connection lives these are on their way even if the
   * receiver has not seen them yet — and are left out when it asks mid-stream
   * for what it lacks. Cleared when the connection goes, and whenever the
   * receiver's list is authoritative (see #onAccept).
   */
  #onLink: Uint8Array
  /** Chunks being read, hashed or handed to the link right now. */
  #inFlight = new Set<number>()
  /** Bumped with each new plan, so progress from an older one is not counted twice. */
  #epoch = 0
  /**
   * Bumped whenever the connection is lost. A send that fails on a connection
   * already given up on says nothing about the current one — letting it count
   * is what pushed a freshly resumed transfer straight back into RECONNECTING.
   */
  #linkGen = 0
  #sentBytes = 0
  #pumping = false
  #pumpRequested = false

  /**
   * Whether the receiver has ever said yes. Until it has, a dropped connection
   * interrupts nothing — there is only an offer, and it simply stands. Treating
   * it as a stalled transfer is what failed files that had not been accepted
   * yet, two minutes after any network blip.
   */
  #accepted = false
  /** The offer never reached the link; it is sent again once it can be. */
  #offerUnsent = false
  /** True once TRANSFER_COMPLETE has gone out for the current plan. */
  #announced = false
  /** When we last asked the peer for something, for the retry clock. */
  #askedAt = 0

  #pausedByUser = false
  /** The other device's user paused. */
  #pausedByPeer = false
  /** The receiver's disk is behind (TRANSFER_FLOW) — not a pause anyone chose. */
  #flowPaused = false
  #wake: (() => void) | null = null

  constructor(options: SendTransferOptions) {
    this.id = options.id
    this.seq = options.seq
    this.peerId = options.peerId
    this.peerName = options.peerName
    this.file = options.file
    this.relPath = options.relPath
    this.batchId = options.batchId
    this.#link = options.link
    this.#onChange = options.onChange
    this.chunkSize = options.chunkSize ?? CHUNK_SIZE
    this.totalChunks = Math.ceil(options.file.size / this.chunkSize)
    this.hasher =
      options.hasher ?? new ChunkTreeHasher(options.file.size, this.chunkSize, this.totalChunks)
    this.#onLink = new Uint8Array(this.totalChunks)
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
    await this.#offer()
  }

  async #offer(): Promise<void> {
    this.#askedAt = Date.now()
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
          ...(this.relPath ? {relPath: this.relPath} : {}),
          ...(this.batchId ? {batchId: this.batchId} : {})
        })
      )
      this.#offerUnsent = false
    } catch {
      // The peer is between connections. That is not a reason to give up on
      // the file: the offer goes out again as soon as it is back.
      this.#offerUnsent = true
    }
  }

  handleMessage(msg: ControlMessage): void {
    this.lastActivity = Date.now()
    switch (msg.t) {
      case 'TRANSFER_ACCEPT':
        this.#onAccept(msg.fromChunk, msg.missing)
        break

      case 'TRANSFER_REJECT':
        this.#finishWith(
          'REJECTED',
          new AppError(msg.reason === 'too-large' ? 'too-large' : 'transfer-rejected', msg.reason)
        )
        break

      case 'TRANSFER_CHECKPOINT':
        // Informational: resumes are driven by the receiver's missing list.
        this.#onChange()
        break

      case 'TRANSFER_FLOW':
        this.#flowPaused = msg.paused
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
        this.#fail(new AppError(codeFromPeer(msg.code), msg.detail))
        break

      default:
        break
    }
  }

  #onAccept(fromChunk: number, missing: ChunkRange[] | undefined): void {
    if (isTerminal(this.state)) return
    if (fromChunk > this.totalChunks) return

    // Mid-stream, a chunk the receiver lacks may simply not have reached it
    // yet: it is on the link, or about to be. A receiver nudging a slow link
    // must not make us send the whole pipe twice. Otherwise its list is the
    // truth — after a drop the pipe is gone, and once COMPLETE is out every
    // chunk before it has been delivered, since it rode the same ordered path
    // behind them — so whatever it lacks was lost, and is sent again.
    const midStream = this.state === 'TRANSFERRING' || this.state === 'PAUSED'
    if (!midStream) this.#onLink.fill(0)
    const plan = ChunkPlan.fromAccept(
      fromChunk,
      this.totalChunks,
      missing,
      midStream ? index => this.#onLink[index] === 1 || this.#inFlight.has(index) : undefined
    )
    this.#accepted = true
    this.#plan = plan
    this.#epoch++
    // Progress is what the receiver has, which is everything it did not ask for.
    this.#sentBytes = this.file.size - plan.bytes(this.file.size, this.chunkSize)
    this.#announced = false
    this.#flowPaused = false
    this.#pausedByPeer = false
    this.#speed.reset()
    // Bytes are flowing again, so the reconnect clock starts fresh next time.
    this.#lostAt = null
    this.startedAt ??= Date.now()

    if (this.#pausedByUser) {
      // Our own pause stands. The plan is kept for when it is lifted, and the
      // receiver is reminded, in case the first notice was lost.
      void this.#send(message({t: 'TRANSFER_PAUSE', transferId: this.id}))
      this.#onChange()
      return
    }
    this.#transition('TRANSFERRING')
    this.#signal()
    void this.#pump()
  }

  // ------------------------------------------------------------- user actions

  pause(): void {
    if (this.state !== 'TRANSFERRING') return
    this.#pausedByUser = true
    this.#transition('PAUSED')
    void this.#send(message({t: 'TRANSFER_PAUSE', transferId: this.id}))
  }

  resume(): void {
    if (this.state !== 'PAUSED') return
    this.#pausedByUser = false
    this.#pausedByPeer = false
    this.#speed.reset()
    this.#transition('TRANSFERRING')
    this.#signal()
    void this.#pump()
    // The receiver answers with what it lacks, which re-plans from there.
    void this.#renegotiate()
  }

  cancel(notifyPeer = true): void {
    if (isTerminal(this.state)) return
    this.#finishWith('CANCELLED', new AppError('transfer-cancelled'))
    if (notifyPeer) {
      void this.#send(message({t: 'TRANSFER_CANCEL', transferId: this.id, reason: 'user'}))
    }
  }

  // ------------------------------------------------------- connection changes

  onPeerLost(): void {
    // Whatever was in flight went with the connection.
    this.#linkGen++
    this.#onLink.fill(0)
    if (isTerminal(this.state) || this.state === 'QUEUED' || this.state === 'PAUSED') return
    // An offer the receiver has not answered has nothing in flight to lose.
    if (!this.#accepted) return
    this.#flowPaused = false
    this.#speed.reset()
    this.#lostAt ??= Date.now()
    // Reachable from VERIFYING too: a drop between "all sent" and the verdict
    // must not strand the transfer.
    this.#transition('RECONNECTING')
  }

  onPeerRestored(): void {
    if (this.state === 'WAITING_FOR_ACCEPT') {
      // Re-offered, because whatever happened to the connection may have taken
      // the offer — or the answer to it — with it. The receiver ignores an
      // offer it already has, and answers again one it has already decided.
      void this.#offer()
      return
    }
    this.#signal()
    if (this.state === 'RECONNECTING') this.#askToContinue()
  }

  /**
   * Restarts the conversation after a drop: the completion again if every
   * chunk was already out, otherwise a resume, which the receiver answers with
   * exactly the chunks it still lacks.
   */
  #askToContinue(): void {
    if (this.#announced) void this.#sendComplete()
    else void this.#renegotiate()
  }

  async #renegotiate(): Promise<void> {
    if (isTerminal(this.state)) return
    this.#askedAt = Date.now()
    await this.#send(
      message({
        t: 'TRANSFER_RESUME',
        transferId: this.id,
        identity: {size: this.file.size, lastModified: this.file.lastModified, chunkSize: this.chunkSize}
      })
    )
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

  /** Periodic upkeep: ask again for anything unanswered, then check for a stall. */
  tick(now = Date.now()): void {
    this.#retry(now)
    this.checkStall(now)
  }

  /**
   * Re-sends whatever this end is waiting on an answer to.
   *
   * Messages can vanish without an error on either side — queued on a channel
   * that then closed, or sent while the peer was between connections — and a
   * protocol where each side waits for the other has no other way out. Each of
   * these is idempotent at the receiver.
   */
  #retry(now: number): void {
    if (now - this.#askedAt < TIMEOUTS.retryMs || !this.#link.isConnected()) return
    if (this.state === 'WAITING_FOR_ACCEPT' && this.#offerUnsent) void this.#offer()
    else if (this.state === 'RECONNECTING') this.#askToContinue()
    else if (this.state === 'VERIFYING' && this.#announced) void this.#sendComplete()
  }

  checkStall(now = Date.now()): void {
    // VERIFYING is included: waiting forever for a verdict is also a stall.
    if (!['TRANSFERRING', 'RECONNECTING', 'VERIFYING'].includes(this.state)) return
    const reconnecting = this.state === 'RECONNECTING'
    const limit = reconnecting ? TIMEOUTS.reconnectWindowMs : TIMEOUTS.transferStallMs
    // While reconnecting, measure from the first drop rather than the last sign
    // of life, so a flapping peer cannot hold the transfer open forever.
    const since = reconnecting ? (this.#lostAt ?? this.lastActivity) : this.lastActivity
    if (now - since > limit) {
      this.#fail(new AppError(reconnecting ? 'connection-lost' : 'transfer-stalled'))
    }
  }

  // -------------------------------------------------------------- the pump

  async #pump(): Promise<void> {
    // A new ACCEPT can replace the plan while a pass is already draining.
    // Recording the request means the running pass makes another lap instead
    // of the "already pumping" guard swallowing the restart.
    this.#pumpRequested = true
    if (this.#pumping) return
    this.#pumping = true

    try {
      while (this.#pumpRequested) {
        this.#pumpRequested = false

        while (!this.#plan.done) {
          await this.#waitUntilRunnable()
          if (isTerminal(this.state)) return

          await this.#flow.acquire()
          const index = isTerminal(this.state) || this.#blocked() ? null : this.#plan.take()
          if (index === null) {
            this.#flow.release()
            continue
          }
          this.#inFlight.add(index)
          void this.#sendChunk(index, this.#epoch, this.#linkGen).finally(() => {
            this.#inFlight.delete(index)
            this.#flow.release()
          })
        }

        await this.#flow.drain()
        if (this.state !== 'TRANSFERRING') continue
        if (!this.#plan.done) {
          // A new plan arrived while the last chunks were draining.
          this.#pumpRequested = true
          continue
        }
        if (!this.hasher.complete) {
          // Everything asked for is out, but some chunk was never hashed — a
          // receiver claiming chunks this sender never sent. Send those too,
          // rather than announce a hash that cannot be computed.
          this.#plan = ChunkPlan.of(this.hasher.missingRanges(MAX_MISSING_RANGES))
          this.#pumpRequested = true
          continue
        }
        if (!this.#announced) await this.#announceComplete()
      }
    } finally {
      this.#pumping = false
    }
  }

  async #sendChunk(index: number, epoch: number, linkGen: number): Promise<void> {
    const offset = index * this.chunkSize
    const length = Math.min(this.chunkSize, this.file.size - offset)

    let payload: Bytes
    try {
      payload = new Uint8Array(await this.file.slice(offset, offset + length).arrayBuffer())
    } catch (err) {
      // Deleted, moved or rewritten since it was picked. No reconnect will fix
      // that, so fail now and say so, and tell the receiver it can stop waiting.
      this.#failAndTell(readFailure(err))
      return
    }
    if (payload.byteLength !== length) {
      this.#failAndTell(new AppError('file-changed'))
      return
    }

    await this.hasher.ensure(index, payload)
    if (isTerminal(this.state) || linkGen !== this.#linkGen) return

    try {
      await this.#link.sendChunk(encodeChunk(this.seq, index, payload))
    } catch {
      if (linkGen === this.#linkGen) this.#onLinkFailure()
      return
    }
    if (linkGen === this.#linkGen) this.#onLink[index] = 1
    // A newer plan already counted this chunk as on its way.
    if (epoch !== this.#epoch) return

    this.#sentBytes = Math.min(this.file.size, this.#sentBytes + length)
    this.#speed.record(length)
    this.lastActivity = Date.now()
    this.#onChange()
  }

  /**
   * A send failed, so the connection is in doubt. Nothing is rewound here: the
   * receiver's answer to the resume says exactly what arrived and what did not.
   * The resume itself goes out when the peer is restored, or from `tick` if the
   * peer never appeared to leave.
   */
  #onLinkFailure(): void {
    this.#linkGen++
    this.#onLink.fill(0)
    if (this.state !== 'TRANSFERRING') return
    this.#lostAt ??= Date.now()
    this.#transition('RECONNECTING')
  }

  async #announceComplete(): Promise<void> {
    try {
      await this.hasher.root()
    } catch (err) {
      this.#failAndTell(new AppError('unknown', err instanceof Error ? err.message : String(err)))
      return
    }
    if (isTerminal(this.state)) return
    this.#announced = true
    this.#transition('VERIFYING')
    await this.#sendComplete()
  }

  async #sendComplete(): Promise<void> {
    this.#askedAt = Date.now()
    const contentHash = await this.hasher.root()
    // Behind the chunks, never ahead of them: the receiver judges completeness
    // the moment this arrives.
    await this.#send(message({t: 'TRANSFER_COMPLETE', transferId: this.id, contentHash}), true)
  }

  // ---------------------------------------------------------------- internals

  /** Fire-and-forget: a lost message is recovered by `#retry`, not by failing. */
  async #send(msg: ControlMessage, afterChunks = false): Promise<void> {
    try {
      await this.#link.sendControl(msg, afterChunks ? {afterChunks} : undefined)
    } catch {
      // The peer is gone for now; reconnecting re-establishes state.
    }
  }

  #failAndTell(error: AppError): void {
    if (isTerminal(this.state)) return
    this.#fail(error)
    void this.#send(
      message({t: 'TRANSFER_ERROR', transferId: this.id, code: error.code, detail: error.detail?.slice(0, 500)})
    )
  }

  #blocked(): boolean {
    return (
      this.state !== 'TRANSFERRING' ||
      this.#pausedByUser ||
      this.#pausedByPeer ||
      this.#flowPaused ||
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
    this.#view = keepIfSame<TransferView>(this.#view, {
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
      batchId: this.batchId ?? null,
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
    })
    return this.#view
  }
}
