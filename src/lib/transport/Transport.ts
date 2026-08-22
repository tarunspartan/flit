import type {AppError} from '../core/errors.ts'

/**
 * The seam that keeps Trystero replaceable (spec §23). Nothing above this file
 * knows about SDP, ICE candidates, TURN credentials, or Trystero itself.
 */

export type PeerId = string

/** How the bytes are actually travelling (§52.2). */
export const PATH_KINDS = ['local', 'direct', 'relay', 'unknown'] as const
export type PathKind = (typeof PATH_KINDS)[number]

export interface NetworkPath {
  kind: PathKind
  /** Always the transport protocol, kept separate from the network path (§53). */
  protocol: string
  /** Human-facing network description: "Local Wi-Fi", "Internet", … */
  network: string
  roundTripMs: number | null
}

export const UNKNOWN_PATH: NetworkPath = {
  kind: 'unknown',
  protocol: 'WebRTC DataChannel',
  network: 'Connecting…',
  roundTripMs: null
}

/**
 * Which peers should be reported as gone, judged from their own connections.
 *
 * Trystero announces a peer leaving over the relay, which only works when the
 * other end is still in a position to say so. A browser that was killed, slept,
 * or dropped off its network says nothing — so the link sits in one device's
 * roster looking healthy while the device at the other end has already given up
 * on it. The connection's own state is first-hand evidence and is symmetric:
 * each end sees its own connection fail.
 *
 * Only terminal states count. `failed` and `closed` are states WebRTC never
 * spontaneously returns from, so acting on them cannot produce a false
 * positive. Absence from the room map deliberately does *not* count: Trystero
 * fires its own leave event for that, and treating a missing id as death races
 * with joining — a peer is added to `#paths` and polled before Trystero's map
 * has caught up, which would report a brand-new peer dead on arrival.
 *
 * Pure so it can be tested; the adapter owns the polling and the emitting.
 *
 * @param states   peer id → connection state, for everyone in the room
 * @param reported peers already announced gone; mutated to stay in step
 */
export function deadLinks(
  states: Map<PeerId, RTCPeerConnectionState | undefined>,
  reported: Set<PeerId>
): PeerId[] {
  const gone: PeerId[] = []

  for (const [peerId, state] of states) {
    // 'disconnected' is deliberately excluded: WebRTC uses it for a transient
    // blip that routinely recovers. Only states it never returns from count.
    if (state === 'failed' || state === 'closed') {
      if (!reported.has(peerId)) {
        reported.add(peerId)
        gone.push(peerId)
      }
    } else {
      // A peer that came back can be reported gone again later.
      reported.delete(peerId)
    }
  }

  return gone
}

export interface TransportEvents extends Record<string, unknown> {
  peerJoin: {peerId: PeerId}
  peerLeave: {peerId: PeerId}
  control: {peerId: PeerId; raw: unknown}
  chunk: {peerId: PeerId; data: Uint8Array}
  path: {peerId: PeerId; path: NetworkPath}
  error: {error: AppError}
}

export interface Transport {
  readonly selfId: string
  join(code: string): Promise<void>
  leave(): Promise<void>
  sendControl(peerId: PeerId, message: unknown): Promise<void>
  sendChunk(peerId: PeerId, frame: Uint8Array): Promise<void>
  pathFor(peerId: PeerId): NetworkPath
  peers(): PeerId[]
  /**
   * Whether signaling looks reachable. On the interface because the session's
   * health reporting depends on it — it was being called on the concrete
   * adapter, which is what forced the field above to be typed to that class
   * and kept the whole module off the seam.
   */
  signalingReady(): boolean
  on<K extends keyof TransportEvents>(
    event: K,
    listener: (payload: TransportEvents[K]) => void
  ): () => void
}
