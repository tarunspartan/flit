import {Emitter} from '../core/events.ts'
import {AppError} from '../core/errors.ts'
import {
  UNKNOWN_PATH,
  type NetworkPath,
  type PeerId,
  type Transport,
  type TransportEvents
} from './Transport.ts'

/**
 * The second adapter behind the Transport seam.
 *
 * `TrysteroTransport` was the only implementation, which made `Transport` a
 * seam in name only: the module above it — session lifecycle, peer trust,
 * reconnect, signaling health — could not be exercised without real WebRTC and
 * live relays, so none of it was. This is the same move `PeerLink` already
 * makes one level down, where an in-memory pair is what lets the transfer
 * protocol be tested end to end.
 *
 * It is a real implementation of the interface rather than a stub: two
 * transports on one `MemoryNetwork` genuinely deliver to each other, so two
 * `SessionManager`s can hold a conversation in a test with no network at all.
 *
 * Delivery is asynchronous and messages are round-tripped through JSON, both
 * to match what the wire actually does — a control message that cannot survive
 * serialization should fail here too, not only in a browser.
 */

let counter = 0

/** The shared medium. One per test; transports on it can reach each other. */
export class MemoryNetwork {
  #rooms = new Map<string, Set<MemoryTransport>>()

  /**
   * Whether signaling looks reachable. `SessionManager` polls this to decide
   * between 'ok', 'retrying' and 'offline', which is the logic the commit
   * history kept returning to.
   */
  signalingReady = true

  /** Delivery delay in ms. Zero keeps tests fast; raise it to stagger arrival. */
  latency = 0

  members(code: string): Set<MemoryTransport> {
    let room = this.#rooms.get(code)
    if (!room) {
      room = new Set()
      this.#rooms.set(code, room)
    }
    return room
  }

  find(code: string, peerId: PeerId): MemoryTransport | undefined {
    for (const member of this.members(code)) if (member.selfId === peerId) return member
    return undefined
  }

  deliver(fn: () => void): void {
    setTimeout(fn, this.latency)
  }
}

/** Settles anything this network has in flight. */
export function flush(times = 3): Promise<void> {
  return new Promise(resolve => {
    let left = times
    const step = () => (left-- > 0 ? setTimeout(step, 0) : resolve())
    step()
  })
}

export class MemoryTransport implements Transport {
  readonly selfId: string
  /** Exposed so a test can assert the preference reached the transport. */
  readonly localOnly: boolean

  #network: MemoryNetwork
  #emitter = new Emitter<TransportEvents>()
  #code: string | null = null
  #path: NetworkPath = {
    kind: 'local',
    protocol: 'WebRTC DataChannel',
    network: 'Local network',
    roundTripMs: 4
  }

  constructor(network: MemoryNetwork, options: {localOnly?: boolean} = {}) {
    this.#network = network
    this.localOnly = options.localOnly ?? false
    this.selfId = `mem-${++counter}`
  }

  on<K extends keyof TransportEvents>(
    event: K,
    listener: (payload: TransportEvents[K]) => void
  ): () => void {
    return this.#emitter.on(event, listener)
  }

  async join(code: string): Promise<void> {
    if (this.#code) throw new AppError('unknown', 'transport already joined')
    this.#code = code
    const room = this.#network.members(code)
    const existing = [...room]
    room.add(this)

    // Asynchronous on purpose: the real transport learns about peers through
    // relay callbacks, well after join() has resolved. Announcing them inline
    // would let a test pass against ordering the browser never produces.
    this.#network.deliver(() => {
      for (const peer of existing) {
        if (!room.has(peer)) continue
        this.#emitter.emit('peerJoin', {peerId: peer.selfId})
        peer.#emitter.emit('peerJoin', {peerId: this.selfId})
      }
    })
  }

  async leave(): Promise<void> {
    const code = this.#code
    if (!code) return
    this.#code = null
    const room = this.#network.members(code)
    room.delete(this)
    for (const peer of room) peer.#emitter.emit('peerLeave', {peerId: this.selfId})
    this.#emitter.clear()
  }

  async sendControl(peerId: PeerId, message: unknown): Promise<void> {
    // Serialized rather than passed by reference, exactly as the wire does, so
    // a message carrying something unserializable fails here too.
    const wire = JSON.stringify(message)
    this.#send(peerId, peer =>
      peer.#emitter.emit('control', {peerId: this.selfId, raw: JSON.parse(wire)})
    )
  }

  async sendChunk(peerId: PeerId, frame: Uint8Array): Promise<void> {
    const copy = new Uint8Array(frame)
    this.#send(peerId, peer => peer.#emitter.emit('chunk', {peerId: this.selfId, data: copy}))
  }

  pathFor(peerId: PeerId): NetworkPath {
    return this.#peer(peerId) ? this.#path : UNKNOWN_PATH
  }

  peers(): PeerId[] {
    if (!this.#code) return []
    return [...this.#network.members(this.#code)]
      .filter(peer => peer !== this)
      .map(peer => peer.selfId)
  }

  signalingReady(): boolean {
    return this.#network.signalingReady
  }

  // ------------------------------------------------------------- test control

  /** Reclassifies this device's link and announces it, as ICE polling does. */
  setPath(path: NetworkPath): void {
    this.#path = path
    for (const peerId of this.peers()) this.#emitter.emit('path', {peerId, path})
  }

  /** Raises a transport-level failure on this device only. */
  fail(error: AppError): void {
    this.#emitter.emit('error', {error})
  }

  /**
   * Drops off the network without a clean leave — the tab-was-killed case,
   * which is what the peers left behind actually have to cope with.
   */
  vanish(): void {
    const code = this.#code
    if (!code) return
    this.#code = null
    const room = this.#network.members(code)
    room.delete(this)
    for (const peer of room) {
      this.#network.deliver(() => peer.#emitter.emit('peerLeave', {peerId: this.selfId}))
    }
  }

  #peer(peerId: PeerId): MemoryTransport | undefined {
    return this.#code ? this.#network.find(this.#code, peerId) : undefined
  }

  #send(peerId: PeerId, hand: (peer: MemoryTransport) => void): void {
    const peer = this.#peer(peerId)
    // A message to someone who has gone is dropped, not thrown: that is what a
    // real link does, and the protocol above is built to tolerate it.
    if (!peer) return
    this.#network.deliver(() => hand(peer))
  }
}
