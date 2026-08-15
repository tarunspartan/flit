import type {AppError} from '../core/errors.ts'

/**
 * The seam that keeps Trystero replaceable (spec §23). Nothing above this file
 * knows about SDP, ICE candidates, TURN credentials, or Trystero itself.
 */

export type PeerId = string

/** How the bytes are actually travelling (§52.2). */
export type PathKind = 'local' | 'direct' | 'relay' | 'unknown'

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
  on<K extends keyof TransportEvents>(
    event: K,
    listener: (payload: TransportEvents[K]) => void
  ): () => void
}
