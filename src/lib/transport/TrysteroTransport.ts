import {getRelaySockets, joinRoom, selfId, type Room} from 'trystero/nostr'
import {APP_ID, RELAY_URLS} from '../core/config.ts'
import {Emitter} from '../core/events.ts'
import {AppError} from '../core/errors.ts'
import {deriveRoomTopic} from '../core/ids.ts'
import {classifyPath, steadyPath} from './pathClassifier.ts'
import {resolveIceServers} from './iceServers.ts'
import {
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
 * The only file in the app that imports Trystero.
 *
 * Pairing code handling matters here: the code is used as the Trystero
 * `password` (which encrypts signaling payloads) while the *topic* published to
 * the relay is a hash of it. A relay operator therefore sees an opaque topic
 * and ciphertext, and cannot join the room or recover the code.
 */
export class TrysteroTransport implements Transport {
  readonly selfId = selfId

  #room: Room | null = null
  #emitter = new Emitter<TransportEvents>()
  #paths = new Map<PeerId, NetworkPath>()
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
      this.#emitter.emit('peerJoin', {peerId})
      void this.#pollPaths()
      this.#startPolling()
    }

    room.onPeerLeave = peerId => {
      this.#paths.delete(peerId)
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

    for (const [peerId, connection] of Object.entries(room.getPeers())) {
      const previous = this.#paths.get(peerId)
      const path = steadyPath(previous, await classifyPath(connection))
      this.#paths.set(peerId, path)
      // Only wake the UI when the classification actually changes; RTT drifts
      // constantly and is read from the snapshot instead.
      if (!previous || previous.kind !== path.kind || previous.network !== path.network) {
        this.#emitter.emit('path', {peerId, path})
      }
    }
  }
}
