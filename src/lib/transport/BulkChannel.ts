import {BULK_HIGH_WATER, BULK_LOW_WATER} from '../core/config.ts'
import {AppError} from '../core/errors.ts'

/**
 * The data channel file bytes travel on, one per peer connection.
 *
 * Trystero multiplexes everything over a single channel of its own and splits
 * every message into 16 KiB pieces. Carrying file data that way cost two full
 * copies per chunk and a reassembly on the far side, queued control messages
 * behind megabytes of file data, and — worst — its send gives up silently: if
 * the channel does not drain within ten seconds, or closes mid-message, the
 * promise *resolves* with the message half sent. A chunk or a TRANSFER_COMPLETE
 * could vanish while both ends believed it delivered.
 *
 * This channel is created on the same RTCPeerConnection, but negotiated out of
 * band: both ends create it with the same id, so it needs no signaling and
 * opens as soon as it exists. A send here either reaches the channel or throws,
 * and backpressure is ours to set.
 *
 * Older builds do not create it, so each end says hello on it first and only
 * uses it once the other has answered. Until then — or for good, with a peer
 * that never does — the caller falls back to Trystero's channel.
 */

/**
 * Fixed stream id for the negotiated channel. Trystero opens exactly one
 * channel of its own, which the browser numbers 0 or 1; this stays clear of it
 * and well inside every browser's stream limit.
 */
export const BULK_CHANNEL_ID = 16
const LABEL = 'flit-bulk'
const HELLO = 'flit-bulk:hello'
const ACK = 'flit-bulk:ack'

/** How long to wait for the other end to answer before settling on the fallback. */
export const BULK_HANDSHAKE_MS = 5000

/** Per the WebRTC spec, what an endpoint that says nothing about it must accept. */
const DEFAULT_MAX_MESSAGE = 64 * 1024

export interface BulkHandlers {
  onChunk(data: Uint8Array): void
  /** A control message sent in order with the chunks — TRANSFER_COMPLETE. */
  onControl(raw: string): void
}

/** The parts of RTCDataChannel used here, so tests can stand one in. */
export type ChannelLike = Pick<
  RTCDataChannel,
  | 'readyState'
  | 'bufferedAmount'
  | 'bufferedAmountLowThreshold'
  | 'binaryType'
  | 'send'
  | 'close'
  | 'onopen'
  | 'onclose'
  | 'onerror'
  | 'onmessage'
  | 'onbufferedamountlow'
>

export class BulkChannel {
  /** True once both ends speak this channel; false if the peer never answers. */
  readonly ready: Promise<boolean>
  /** Largest single message the far end accepts. */
  readonly maxMessageSize: number

  #channel: ChannelLike
  #handlers: BulkHandlers
  #settle: (ready: boolean) => void = () => {}
  #settled = false
  #closed = false
  #drainWaiters: {resolve: () => void; reject: (err: Error) => void}[] = []
  #handshakeTimer: ReturnType<typeof setTimeout>

  /** Opens the channel on a live connection, or returns null if the browser refuses. */
  static open(pc: RTCPeerConnection, handlers: BulkHandlers): BulkChannel | null {
    try {
      const channel = pc.createDataChannel(LABEL, {negotiated: true, id: BULK_CHANNEL_ID, ordered: true})
      return new BulkChannel(channel, handlers, pc.sctp?.maxMessageSize)
    } catch {
      return null
    }
  }

  constructor(channel: ChannelLike, handlers: BulkHandlers, maxMessageSize?: number) {
    this.#channel = channel
    this.#handlers = handlers
    this.maxMessageSize =
      maxMessageSize !== undefined && maxMessageSize > 0 ? maxMessageSize : DEFAULT_MAX_MESSAGE
    this.ready = new Promise(resolve => {
      this.#settle = resolve
    })

    channel.binaryType = 'arraybuffer'
    channel.bufferedAmountLowThreshold = BULK_LOW_WATER
    channel.onopen = () => this.#say(HELLO)
    channel.onmessage = event => this.#receive(event.data)
    channel.onbufferedamountlow = () => this.#wakeDrainWaiters()
    channel.onclose = () => this.#shutdown()
    channel.onerror = () => this.#shutdown()
    if (channel.readyState === 'open') this.#say(HELLO)

    this.#handshakeTimer = setTimeout(() => this.#decide(false), BULK_HANDSHAKE_MS)
  }

  /**
   * Queues a chunk frame or an in-order control message. Waits while the
   * channel holds more than BULK_HIGH_WATER; rejects if it closes — it never
   * pretends a message was sent.
   */
  async send(data: Uint8Array | string): Promise<void> {
    const size = typeof data === 'string' ? data.length : data.byteLength
    while (!this.#closed && this.#channel.bufferedAmount > 0 &&
      this.#channel.bufferedAmount + size > BULK_HIGH_WATER) {
      await this.#drained()
    }
    if (this.#closed || this.#channel.readyState !== 'open') {
      throw new AppError('connection-lost', 'data channel closed')
    }
    try {
      // Cast: TypeScript's send() overloads do not accept the union.
      this.#channel.send(data as string)
    } catch (err) {
      throw new AppError('connection-lost', err instanceof Error ? err.message : String(err))
    }
  }

  close(): void {
    if (this.#closed) return
    this.#shutdown()
    try {
      this.#channel.close()
    } catch {
      // Already closing with its connection.
    }
  }

  #receive(data: unknown): void {
    if (typeof data === 'string') {
      if (data === HELLO) {
        this.#decide(true)
        this.#say(ACK)
      } else if (data === ACK) {
        this.#decide(true)
      } else {
        this.#handlers.onControl(data)
      }
      return
    }
    if (data instanceof ArrayBuffer) this.#handlers.onChunk(new Uint8Array(data))
  }

  #say(word: string): void {
    try {
      if (this.#channel.readyState === 'open') this.#channel.send(word)
    } catch {
      // If this is lost, the other end's own hello still reaches us.
    }
  }

  /**
   * Settles readiness once. A hello arriving after the fallback was chosen is
   * still answered — the other end may then use this channel to send to us,
   * which we receive either way — but our own choice stays made, so everything
   * we send on this connection keeps to one ordered path.
   */
  #decide(ready: boolean): void {
    if (this.#settled) return
    this.#settled = true
    clearTimeout(this.#handshakeTimer)
    this.#settle(ready)
  }

  #drained(): Promise<void> {
    if (this.#channel.bufferedAmount <= BULK_LOW_WATER) return Promise.resolve()
    return new Promise((resolve, reject) => {
      this.#drainWaiters.push({resolve, reject})
      // A backstop in case a browser misses the event; the caller re-checks.
      setTimeout(resolve, 1000)
    })
  }

  #wakeDrainWaiters(): void {
    const waiters = this.#drainWaiters
    this.#drainWaiters = []
    for (const waiter of waiters) waiter.resolve()
  }

  #shutdown(): void {
    if (this.#closed) return
    this.#closed = true
    this.#decide(false)
    const waiters = this.#drainWaiters
    this.#drainWaiters = []
    const err = new AppError('connection-lost', 'data channel closed')
    for (const waiter of waiters) waiter.reject(err)
  }
}
