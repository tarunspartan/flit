import {getRelaySockets, joinRoom, selfId, type Room} from 'trystero/nostr'
import {APP_ID, RELAY_URLS} from '../core/config.ts'
import {Emitter} from '../core/events.ts'
import {AppError} from '../core/errors.ts'
import {deriveRoomTopic} from '../core/ids.ts'
import {classifyPath, steadyPath} from './pathClassifier.ts'
import {resolveIceServers} from './iceServers.ts'
import {
  deadLinks,
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

/**
 * The only file in the app that imports Trystero.
 *
 * Pairing code handling matters here: the code is used as the Trystero
 * `password` (which encrypts signaling payloads) while the *topic* published to
 * the relay is a hash of it. A relay operator therefore sees an opaque topic
 * and ciphertext, and cannot join the room or recover the code.
 */
/**
 * How much may sit queued on a data channel before the sender pauses.
 *
 * Trystero sets this to 64 KB and waits for `bufferedamountlow` whenever more
 * than that is outstanding. Profiling a 200 MB send showed 99.5% of the
 * sender's time inside that wait — reading the file and hashing it together
 * came to 0.5% — so the queue depth, not the CPU, is what sets the rate.
 */
const BUFFER_HIGH_WATER = 8 * 1024 * 1024

/**
 * Raises that high-water mark for every data channel in the page.
 *
 * Patched on the prototype rather than on the channel because Trystero owns
 * the channel and exposes neither end of it: the initiator creates it with
 * createDataChannel, the answerer receives it through ondatachannel. The
 * setter only ever raises a value, so anything asking for a deeper queue than
 * ours still gets what it asked for.
 */
let bufferPatched = false
function raiseChannelBuffering(): void {
  if (bufferPatched || typeof RTCDataChannel === 'undefined') return
  bufferPatched = true
  const proto = RTCDataChannel.prototype
  const original = Object.getOwnPropertyDescriptor(proto, 'bufferedAmountLowThreshold')
  if (!original?.get || !original.set) return
  const {get, set} = original
  Object.defineProperty(proto, 'bufferedAmountLowThreshold', {
    configurable: true,
    enumerable: original.enumerable,
    get,
    set(this: RTCDataChannel, value: number) {
      set.call(this, Math.max(value, BUFFER_HIGH_WATER))
    }
  })
}

export class TrysteroTransport implements Transport {
  readonly selfId = selfId

  #room: Room | null = null
  #emitter = new Emitter<TransportEvents>()
  #paths = new Map<PeerId, NetworkPath>()
  /** When each peer's connection appeared, for PATH_SETTLE_MS. */
  #pathSince = new Map<PeerId, number>()
  #pathTimer: ReturnType<typeof setInterval> | null = null
  #localOnly: boolean
  #sendControl: ((data: unknown, options: {target: string}) => Promise<void>) | null = null
  #sendChunk: ((data: Uint8Array, options: {target: string}) => Promise<void>) | null = null

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
    // Before any channel exists, so both the one we create and the one the
    // other device offers us are covered.
    raiseChannelBuffering()

    const topic = await deriveRoomTopic(APP_ID, code)
    const iceServers = resolveIceServers(this.#localOnly)

    const room = joinRoom(
      {
        appId: APP_ID,
        password: code,
        // Left to itself Trystero would pick five relays from its defaults, and
        // for this appId four of those five are dead. See RELAY_URLS.
        relayConfig: {urls: RELAY_URLS},
        rtcConfig: {
          iceServers,
          // Gather host candidates from every interface so a same-LAN pair is
          // found quickly instead of after a STUN round trip.
          iceCandidatePoolSize: 2
        }
      },
      topic,
      {
        onJoinError: details => {
          this.#emitter.emit('error', {
            error: new AppError('connection-failed', details.error)
          })
        }
      }
    )
    this.#room = room

    // Trystero types payloads as its own JSON union; the protocol layer does
    // the real validation, so these are handled as opaque values here.
    const control = room.makeAction(CONTROL_ACTION)
    const chunk = room.makeAction<Uint8Array>(CHUNK_ACTION)
    this.#sendControl = control.send as (data: unknown, options: {target: string}) => Promise<void>
    this.#sendChunk = chunk.send

    control.onMessage = (data, context) => {
      this.#emitter.emit('control', {peerId: context.peerId, raw: data})
    }
    chunk.onMessage = (data, context) => {
      this.#emitter.emit('chunk', {peerId: context.peerId, data})
    }

    room.onPeerJoin = peerId => {
      this.#paths.set(peerId, UNKNOWN_PATH)
      this.#pathSince.set(peerId, Date.now())
      this.#emitter.emit('peerJoin', {peerId})
      void this.#pollPaths()
      this.#startPolling()
    }

    room.onPeerLeave = peerId => {
      this.#paths.delete(peerId)
      this.#pathSince.delete(peerId)
      this.#emitter.emit('peerLeave', {peerId})
      if (Object.keys(room.getPeers()).length === 0) this.#stopPolling()
    }
  }

  async leave(): Promise<void> {
    this.#stopPolling()
    const room = this.#room
    this.#room = null
    this.#sendControl = null
    this.#sendChunk = null
    this.#paths.clear()
    this.#reportedGone.clear()
    this.#pathSince.clear()
    this.#emitter.clear()
    if (room) await room.leave().catch(() => {})
  }

  async sendControl(peerId: PeerId, message: unknown): Promise<void> {
    if (!this.#sendControl) throw new AppError('connection-lost', 'transport is not joined')
    await this.#sendControl(message, {target: peerId})
  }

  /**
   * Resolves once the frame has drained into the DataChannel. Trystero waits on
   * `bufferedamountlow` internally, so awaiting this call *is* backpressure —
   * the FlowController layers a bounded in-flight window on top.
   */
  async sendChunk(peerId: PeerId, frame: Uint8Array): Promise<void> {
    if (!this.#sendChunk) throw new AppError('connection-lost', 'transport is not joined')
    await this.#sendChunk(frame, {target: peerId})
  }

  pathFor(peerId: PeerId): NetworkPath {
    return this.#paths.get(peerId) ?? UNKNOWN_PATH
  }

  peers(): PeerId[] {
    return this.#room ? Object.keys(this.#room.getPeers()) : []
  }

  /**
   * Whether any signaling relay socket is actually open.
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

  /** Exposed for diagnostics only; nothing above transport uses this. */
  connectionFor(peerId: PeerId): RTCPeerConnection | null {
    return this.#room?.getPeers()[peerId] ?? null
  }

  /** Links already announced as gone, so a dead one is reported once. */
  #reportedGone = new Set<PeerId>()

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
    const room = this.#room
    if (!room) return

    const peers = room.getPeers()
    this.#reapDeadLinks(peers)

    for (const [peerId, connection] of Object.entries(peers)) {
      if (this.#reportedGone.has(peerId)) continue
      const previous = this.#paths.get(peerId)
      const fresh = await classifyPath(connection)
      const since = this.#pathSince.get(peerId) ?? 0
      const settling =
        fresh.kind === 'direct' &&
        previous?.kind !== 'local' &&
        Date.now() - since < PATH_SETTLE_MS
      const path = settling ? UNKNOWN_PATH : steadyPath(previous, fresh)
      this.#paths.set(peerId, path)
      // Only wake the UI when the classification actually changes; RTT drifts
      // constantly and is read from the snapshot instead.
      if (!previous || previous.kind !== path.kind || previous.network !== path.network) {
        this.#emitter.emit('path', {peerId, path})
      }
    }
  }

  /**
   * Announces links that died without anyone telling us. The decision is
   * `deadLinks`; this owns the polling, the bookkeeping and the emitting.
   */
  #reapDeadLinks(peers: Record<string, RTCPeerConnection>): void {
    const states = new Map(
      Object.entries(peers).map(([peerId, connection]) => [peerId, connection.connectionState])
    )
    for (const peerId of deadLinks(states, this.#reportedGone)) {
      this.#paths.delete(peerId)
      this.#emitter.emit('peerLeave', {peerId})
    }
  }
}
