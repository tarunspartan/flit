import {
  getRelaySockets as nostrSockets,
  joinRoom as joinNostr,
  selfId,
  type JoinRoom,
  type Room
} from 'trystero/nostr'
import {APP_ID, MQTT_BROKER_URLS, RELAY_URLS} from '../core/config.ts'
import {Emitter} from '../core/events.ts'
import {AppError} from '../core/errors.ts'
import {deriveRoomTopic} from '../core/ids.ts'
import {BulkChannel} from './BulkChannel.ts'
import {LinkTable} from './LinkTable.ts'
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
type Sockets = () => Record<string, {readyState?: number} | undefined>

/** One signaling network, and the room joined through it. */
interface Network {
  readonly name: 'nostr' | 'mqtt'
  readonly room: Room
  readonly sendControl: Send<unknown>
  readonly sendChunk: Send<Uint8Array>
  readonly sockets: Sockets
}

/** One connection to one device, introduced over one network. */
interface Link {
  readonly network: Network
  readonly pc: RTCPeerConnection
  readonly bulk: BulkChannel | null
}

/**
 * The only file in the app that imports Trystero.
 *
 * Trystero finds the other devices and keeps the connections up. It does that
 * over two signaling networks at once, because the nostr relays it relies on by
 * default are run by volunteers and fail without notice:
 *
 * - **nostr** (primary) — announces and listens from the start.
 * - **MQTT** (backup) — public brokers run by companies. Every device listens
 *   there passively, which costs a few sockets and no connections; a device
 *   starts announcing there only when `widenSearch()` says nostr has not
 *   delivered a device it expects. A passive listener wakes when it hears an
 *   announcement, so the two meet over MQTT without either having to guess.
 *
 * A device reachable over both is still one device: see LinkTable.
 *
 * File bytes ride a data channel of our own on each connection (BulkChannel);
 * Trystero's channel carries control messages, and file data only for a peer on
 * an older build that has no bulk channel.
 *
 * Pairing code handling matters here: the code is the Trystero `password`
 * (which encrypts signaling payloads) while the *topic* published to a relay or
 * broker is a hash of it. Its operator sees an opaque topic and ciphertext, and
 * can neither join the room nor recover the code.
 */
export class TrysteroTransport implements Transport {
  readonly selfId = selfId

  #emitter = new Emitter<TransportEvents>()
  #links = new LinkTable<Link>()
  #paths = new Map<PeerId, NetworkPath>()
  /** When each peer's current connection appeared, for PATH_SETTLE_MS. */
  #pathSince = new Map<PeerId, number>()
  #pathTimer: ReturnType<typeof setInterval> | null = null
  #localOnly: boolean

  #code: string | null = null
  #topic: string | null = null
  #nostr: Network | null = null
  #backup: Network | null = null
  /** Whether the backup network is (being) joined as an announcer. */
  #backupAnnouncing = false
  /** Serializes joining and rejoining the backup network. */
  #backupTask: Promise<void> = Promise.resolve()
  /** Bumped by leave(), so a backup join still in flight knows it is stale. */
  #generation = 0

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
    if (this.#nostr) throw new AppError('unknown', 'transport already joined')
    if (typeof RTCPeerConnection === 'undefined') {
      throw new AppError('unsupported-browser', 'RTCPeerConnection is unavailable')
    }

    this.#code = code
    this.#topic = await deriveRoomTopic(APP_ID, code)
    // Left to itself Trystero would pick five relays from its defaults, and for
    // this appId four of those five are dead. See RELAY_URLS.
    this.#nostr = this.#joinNetwork('nostr', joinNostr, RELAY_URLS, nostrSockets, false)
    // In the background: the MQTT client is loaded on demand so it never
    // delays the first paint, and a failure to load costs only the backup.
    this.#queueBackup(false)
  }

  async leave(): Promise<void> {
    this.#generation++
    this.#stopPolling()
    for (const [, link] of this.#links.entries()) link.bulk?.close()
    this.#links.clear()
    this.#paths.clear()
    this.#pathSince.clear()
    this.#emitter.clear()
    const rooms = [this.#nostr?.room, this.#backup?.room]
    this.#nostr = null
    this.#backup = null
    this.#backupAnnouncing = false
    this.#code = null
    this.#topic = null
    await Promise.all(rooms.map(room => room?.leave().catch(() => {})))
  }

  widenSearch(): void {
    if (!this.#nostr || this.#backupAnnouncing) return
    // A listener that someone's announcement already woke is announcing too,
    // for as long as it holds connections; rejoining would only cut them. The
    // session asks again while a device is still missing.
    for (const [, link] of this.#links.entries()) if (link.network === this.#backup) return
    this.#backupAnnouncing = true
    this.#queueBackup(true)
  }

  async sendControl(peerId: PeerId, message: unknown, options?: {afterChunks?: boolean}): Promise<void> {
    const link = this.#linkTo(peerId)
    if (options?.afterChunks && link.bulk && (await link.bulk.ready)) {
      // Behind the chunks means on the path the chunks took.
      await link.bulk.send(JSON.stringify(message))
      return
    }
    await link.network.sendControl(message, {target: peerId})
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
    await link.network.sendChunk(frame, {target: peerId})
  }

  maxFrameBytes(peerId: PeerId): number {
    const max = this.#links.active(peerId)?.pc.sctp?.maxMessageSize
    return typeof max === 'number' && max > 0 ? max : FALLBACK_MAX_FRAME
  }

  pathFor(peerId: PeerId): NetworkPath {
    return this.#paths.get(peerId) ?? UNKNOWN_PATH
  }

  peers(): PeerId[] {
    return this.#links.peers()
  }

  /**
   * Whether any signaling socket, on either network, is actually open.
   *
   * This replaces `navigator.onLine`, which reports false on perfectly working
   * connections (VPNs, virtual adapters, several browser quirks) and true on a
   * LAN with no internet at all. An open socket is evidence; a flag is a guess.
   */
  signalingReady(): boolean {
    return [this.#nostr, this.#backup].some(network => {
      if (!network) return false
      try {
        return Object.values(network.sockets()).some(socket => socket?.readyState === WebSocket.OPEN)
      } catch {
        return false
      }
    })
  }

  // ------------------------------------------------------------- networks

  #joinNetwork(
    name: Network['name'],
    join: JoinRoom,
    urls: readonly string[],
    sockets: Sockets,
    passive: boolean
  ): Network {
    const room = join(
      {
        appId: APP_ID,
        password: this.#code ?? '',
        relayConfig: {urls: [...urls]},
        ...(passive ? {passive: true} : {}),
        rtcConfig: {
          iceServers: resolveIceServers(this.#localOnly),
          // Gather host candidates from every interface so a same-LAN pair is
          // found quickly instead of after a STUN round trip.
          iceCandidatePoolSize: 2
        }
      },
      this.#topic ?? '',
      {
        onJoinError: details => {
          // A handshake that failed over one network is no failure at all if
          // the device is connected over the other.
          if (details.peerId && this.#links.active(details.peerId)) return
          this.#emitter.emit('error', {error: new AppError('connection-failed', details.error)})
        }
      }
    )

    // Trystero types payloads as its own JSON union; the protocol layer does
    // the real validation, so these are handled as opaque values here.
    const control = room.makeAction(CONTROL_ACTION)
    const chunk = room.makeAction<Uint8Array>(CHUNK_ACTION)
    const network: Network = {
      name,
      room,
      sendControl: control.send as Send<unknown>,
      sendChunk: chunk.send,
      sockets
    }
    control.onMessage = (data, context) => {
      this.#emitter.emit('control', {peerId: context.peerId, raw: data})
    }
    chunk.onMessage = (data, context) => {
      this.#emitter.emit('chunk', {peerId: context.peerId, data})
    }
    room.onPeerJoin = peerId => this.#linkUp(network, peerId)
    room.onPeerLeave = peerId => this.#linkDown(network, peerId)
    return network
  }

  #queueBackup(announcing: boolean): void {
    const generation = this.#generation
    this.#backupTask = this.#backupTask
      .then(() => this.#joinBackup(announcing, generation))
      .catch(() => {
        // The primary network carries on alone.
      })
  }

  /**
   * Joins the MQTT network, or rejoins it announcing. Trystero fixes a room's
   * passivity when it is joined, so turning a listener into an announcer means
   * leaving and joining again; any connection made over it in between is
   * handed over to nostr's, or dropped and re-made.
   */
  async #joinBackup(announcing: boolean, generation: number): Promise<void> {
    const {joinRoom, getRelaySockets} = await import('@trystero-p2p/mqtt')
    if (generation !== this.#generation) return

    const previous = this.#backup
    if (previous) {
      this.#backup = null
      for (const peerId of this.#links.peers()) this.#linkDown(previous, peerId)
      await previous.room.leave().catch(() => {})
      if (generation !== this.#generation) return
    }
    this.#backup = this.#joinNetwork(
      'mqtt',
      joinRoom,
      MQTT_BROKER_URLS,
      getRelaySockets as Sockets,
      !announcing
    )
  }

  // ------------------------------------------------------------ connections

  #linkTo(peerId: PeerId): Link {
    const link = this.#links.active(peerId)
    if (!link) throw new AppError('connection-lost', 'no connection to that device')
    return link
  }

  #linkUp(network: Network, peerId: PeerId): void {
    const pc = network.room.getPeers()[peerId]
    if (!pc) return
    // Trystero can replace a connection without reporting the old one gone.
    this.#linkDown(network, peerId)

    const link: Link = {
      network,
      pc,
      // On every connection, not just the one in use: the other end may have
      // picked a different one to send on, and its chunks arrive here.
      bulk: BulkChannel.open(pc, {
        onChunk: data => this.#emitter.emit('chunk', {peerId, data}),
        onControl: raw => this.#emitter.emit('control', {peerId, raw})
      })
    }
    if (this.#links.add(peerId, link) === 'arrived') this.#arrived(peerId)
  }

  #linkDown(network: Network, peerId: PeerId): void {
    const link = this.#links.linksOf(peerId).find(candidate => candidate.network === network)
    if (link) this.#drop(peerId, link)
  }

  #drop(peerId: PeerId, link: Link): void {
    link.bulk?.close()
    const change = this.#links.remove(peerId, link)
    if (change === 'departed') {
      this.#paths.delete(peerId)
      this.#pathSince.delete(peerId)
      this.#emitter.emit('peerLeave', {peerId})
      if (this.#links.peers().length === 0) this.#stopPolling()
    } else if (change === 'switched') {
      // Still reachable, over the standby. Anything in flight went with the
      // old connection, so the session hears it as a drop and an immediate
      // return — the path every transfer already knows how to resume from.
      this.#emitter.emit('peerLeave', {peerId})
      this.#arrived(peerId)
    }
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
    for (const [peerId, link] of this.#links.entries()) {
      if (isDeadConnection(link.pc.connectionState)) this.#drop(peerId, link)
    }

    for (const peerId of this.#links.peers()) {
      const link = this.#links.active(peerId)
      if (!link) continue
      const previous = this.#paths.get(peerId)
      const fresh = await classifyPath(link.pc)
      // The connection may have gone, or been replaced, while stats were read.
      if (this.#links.active(peerId) !== link) continue
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
