import {getRelaySockets, joinRoom, selfId, type Room} from 'trystero/nostr'
import {APP_ID, RELAY_URLS} from '../core/config.ts'
import {Emitter} from '../core/events.ts'
import {AppError} from '../core/errors.ts'
import {deriveRoomTopic} from '../core/ids.ts'
import {BulkChannel} from './BulkChannel.ts'
import {classifyPath, steadyPath} from './pathClassifier.ts'
import {resolveIceServers} from './iceServers.ts'
import {
  isDeadConnection,
  UNKNOWN_PATH,
  type NetworkPath,
  type PeerId,
  type Transport,
  type TransportEvents
} from './Transport.ts'

const CONTROL_ACTION = 'ctrl'
const CHUNK_ACTION = 'chunk'
const PATH_POLL_MS = 2000

/**
 * How long a fresh connection may look 'direct' before we say so out loud.
 *
 * ICE nominates whatever pair validates first, which is routinely the
 * STUN-mapped one — the host pair needs mDNS resolution and arrives a moment
 * later, and ICE then renominates to it. Read at that instant the verdict is
 * honestly 'direct', but 'direct' only ever means "locality could not be
 * shown", never "this is remote". Asserting "Internet" from it and correcting
 * to "Local network" seconds later told people their LAN transfer was going
 * over the internet when it was not. A positive finding — 'local' or 'relay' —
 * is evidence and shows immediately; the absence of one waits.
 */
const PATH_SETTLE_MS = 6000

/** Frames can only be sized to fit once the connection says what fits; until then, the spec minimum. */
const FALLBACK_MAX_FRAME = 64 * 1024

type Send<T> = (data: T, options: {target: string}) => Promise<void>

/** The connection to one device. */
interface Link {
  readonly pc: RTCPeerConnection
  readonly bulk: BulkChannel | null
}

/**
 * The only file in the app that imports Trystero.
 *
 * Trystero finds the other devices over nostr relays and keeps the connections
 * up. File bytes ride a data channel of our own on each connection (BulkChannel);
 * Trystero's channel carries control messages, and file data only for a peer on
 * an older build that has no bulk channel.
 *
 * Pairing code handling matters here: the code is the Trystero `password`
 * (which encrypts signaling payloads) while the *topic* published to a relay
 * is a hash of it. A relay operator sees an opaque topic and ciphertext, and
 * can neither join the room nor recover the code.
 */
export class TrysteroTransport implements Transport {
  readonly selfId = selfId

  #emitter = new Emitter<TransportEvents>()
  #links = new Map<PeerId, Link>()
  #paths = new Map<PeerId, NetworkPath>()
  /** When each peer's current connection appeared, for PATH_SETTLE_MS. */
  #pathSince = new Map<PeerId, number>()
  #pathTimer: ReturnType<typeof setInterval> | null = null
  #localOnly: boolean

  #room: Room | null = null
  #sendControl: Send<unknown> | null = null
  #sendChunk: Send<Uint8Array> | null = null

  constructor(options: {localOnly?: boolean} = {}) {
    this.#localOnly = options.localOnly ?? false
  }

  on<K extends keyof TransportEvents>(
    event: K,
    listener: (payload: TransportEvents[K]) => void
  ): () => void {
    return this.#emitter.on(event, listener)
  }

  async join(code: string): Promise<void> {
    if (this.#room) throw new AppError('unknown', 'transport already joined')
    if (typeof RTCPeerConnection === 'undefined') {
      throw new AppError('unsupported-browser', 'RTCPeerConnection is unavailable')
    }

    const topic = await deriveRoomTopic(APP_ID, code)
    const room = joinRoom(
      {
        appId: APP_ID,
        password: code,
        // Left to itself Trystero would pick five relays from its defaults, and
        // for this appId four of those five are dead. See RELAY_URLS.
        relayConfig: {urls: [...RELAY_URLS]},
        rtcConfig: {
          iceServers: resolveIceServers(this.#localOnly),
          // Gather host candidates from every interface so a same-LAN pair is
          // found quickly instead of after a STUN round trip.
          iceCandidatePoolSize: 2
        }
      },
      topic,
      {
        onJoinError: details => {
          // A handshake that lost a race to one that succeeded is no failure.
          if (details.peerId && this.#links.has(details.peerId)) return
          this.#emitter.emit('error', {error: new AppError('connection-failed', details.error)})
        }
      }
    )
    this.#room = room

    // Trystero types payloads as its own JSON union; the protocol layer does
    // the real validation, so these are handled as opaque values here.
    const control = room.makeAction(CONTROL_ACTION)
    const chunk = room.makeAction<Uint8Array>(CHUNK_ACTION)
    this.#sendControl = control.send as Send<unknown>
    this.#sendChunk = chunk.send
    control.onMessage = (data, context) => {
      this.#emitter.emit('control', {peerId: context.peerId, raw: data})
    }
    chunk.onMessage = (data, context) => {
      this.#emitter.emit('chunk', {peerId: context.peerId, data})
    }
    room.onPeerJoin = peerId => this.#linkUp(peerId)
    room.onPeerLeave = peerId => this.#drop(peerId)
  }

  async leave(): Promise<void> {
    this.#stopPolling()
    for (const link of this.#links.values()) link.bulk?.close()
    this.#links.clear()
    this.#paths.clear()
    this.#pathSince.clear()
    this.#emitter.clear()
    const room = this.#room
    this.#room = null
    this.#sendControl = null
    this.#sendChunk = null
    await room?.leave().catch(() => {})
  }

  async sendControl(peerId: PeerId, message: unknown, options?: {afterChunks?: boolean}): Promise<void> {
    const link = this.#linkTo(peerId)
    if (options?.afterChunks && link.bulk && (await link.bulk.ready)) {
      // Behind the chunks means on the path the chunks took.
      await link.bulk.send(JSON.stringify(message))
      return
    }
    await this.#sendControl?.(message, {target: peerId})
  }

  /**
   * Resolves once the frame is queued on the connection, waiting while the
   * channel's buffer is full — so awaiting it *is* backpressure. Rejects if the
   * channel closes rather than pretending the frame went.
   */
  async sendChunk(peerId: PeerId, frame: Uint8Array): Promise<void> {
    const link = this.#linkTo(peerId)
    if (link.bulk && (await link.bulk.ready) && frame.byteLength <= link.bulk.maxMessageSize) {
      await link.bulk.send(frame)
      return
    }
    await this.#sendChunk?.(frame, {target: peerId})
  }

  maxFrameBytes(peerId: PeerId): number {
    const max = this.#links.get(peerId)?.pc.sctp?.maxMessageSize
    return typeof max === 'number' && max > 0 ? max : FALLBACK_MAX_FRAME
  }

  pathFor(peerId: PeerId): NetworkPath {
    return this.#paths.get(peerId) ?? UNKNOWN_PATH
  }

  peers(): PeerId[] {
    return [...this.#links.keys()]
  }

  /**
   * Whether any signaling socket is actually open.
   *
   * This replaces `navigator.onLine`, which reports false on perfectly working
   * connections (VPNs, virtual adapters, several browser quirks) and true on a
   * LAN with no internet at all. An open socket is evidence; a flag is a guess.
   */
  signalingReady(): boolean {
    try {
      const sockets = getRelaySockets() as Record<string, {readyState?: number} | undefined>
      return Object.values(sockets).some(socket => socket?.readyState === WebSocket.OPEN)
    } catch {
      return false
    }
  }

  // ------------------------------------------------------------ connections

  #linkTo(peerId: PeerId): Link {
    const link = this.#links.get(peerId)
    if (!link) throw new AppError('connection-lost', 'no connection to that device')
    return link
  }

  #linkUp(peerId: PeerId): void {
    const pc = this.#room?.getPeers()[peerId]
    if (!pc || this.#links.get(peerId)?.pc === pc) return
    // Trystero can replace a connection without reporting the old one gone.
    this.#drop(peerId)

    this.#links.set(peerId, {
      pc,
      bulk: BulkChannel.open(pc, {
        onChunk: data => this.#emitter.emit('chunk', {peerId, data}),
        onControl: raw => this.#emitter.emit('control', {peerId, raw})
      })
    })
    this.#arrived(peerId)
  }

  /** Forgets a connection and reports the device gone — once, however it was noticed. */
  #drop(peerId: PeerId): void {
    const link = this.#links.get(peerId)
    if (!link) return
    link.bulk?.close()
    this.#links.delete(peerId)
    this.#paths.delete(peerId)
    this.#pathSince.delete(peerId)
    this.#emitter.emit('peerLeave', {peerId})
    if (this.#links.size === 0) this.#stopPolling()
  }

  #arrived(peerId: PeerId): void {
    this.#paths.set(peerId, UNKNOWN_PATH)
    this.#pathSince.set(peerId, Date.now())
    this.#emitter.emit('peerJoin', {peerId})
    void this.#pollPaths()
    this.#startPolling()
  }

  #startPolling(): void {
    this.#pathTimer ??= setInterval(() => void this.#pollPaths(), PATH_POLL_MS)
  }

  #stopPolling(): void {
    if (this.#pathTimer !== null) {
      clearInterval(this.#pathTimer)
      this.#pathTimer = null
    }
  }

  async #pollPaths(): Promise<void> {
    // Connections that died without anyone saying so go first; see isDeadConnection.
    for (const [peerId, link] of this.#links) {
      if (isDeadConnection(link.pc.connectionState)) this.#drop(peerId)
    }

    for (const [peerId, link] of [...this.#links]) {
      const previous = this.#paths.get(peerId)
      const fresh = await classifyPath(link.pc)
      // The connection may have gone, or been replaced, while stats were read.
      if (this.#links.get(peerId) !== link) continue
      const since = this.#pathSince.get(peerId) ?? 0
      const settling =
        fresh.kind === 'direct' &&
        previous?.kind !== 'local' &&
        Date.now() - since < PATH_SETTLE_MS
      const path = settling ? UNKNOWN_PATH : steadyPath(previous, fresh)
      this.#paths.set(peerId, path)
      // Only wake the UI when the classification actually changes; RTT drifts
      // constantly and is read from pathFor() when a snapshot is taken.
      if (!previous || previous.kind !== path.kind || previous.network !== path.network) {
        this.#emitter.emit('path', {peerId, path})
      }
    }
  }
}
