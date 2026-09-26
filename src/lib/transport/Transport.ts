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
 * Whether a connection is dead, judged from its own state.
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
 * positive. 'disconnected' is deliberately excluded: WebRTC uses it for a
 * transient blip that routinely recovers. And a state not known yet — a
 * connection polled before it has one — is not death either; treating it so
 * once reported brand-new peers dead on arrival.
 *
 * Reporting each death once is the adapter's job: a connection is forgotten
 * the moment it is reported.
 */
export function isDeadConnection(state: RTCPeerConnectionState | undefined): boolean {
  return state === 'failed' || state === 'closed'
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
  /**
   * Sends a control message. With `afterChunks`, it is delivered behind every
   * chunk already sent to that peer rather than possibly overtaking them —
   * control and file data otherwise travel separately, so nothing queues
   * behind a large file.
   */
  sendControl(peerId: PeerId, message: unknown, options?: {afterChunks?: boolean}): Promise<void>
  /** Resolves once the frame is queued on the connection; rejects if it cannot be. */
  sendChunk(peerId: PeerId, frame: Uint8Array): Promise<void>
  /** The largest frame the connection to this peer carries as one message. */
  maxFrameBytes(peerId: PeerId): number
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
