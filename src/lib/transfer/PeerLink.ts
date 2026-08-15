import type {Bytes} from '../core/bytes.ts'
import type {ControlMessage} from '../protocol/messages.ts'

/**
 * What a transfer is allowed to know about the connection: how to send, and
 * whether the peer is currently reachable. No peer ids, no channels, no ICE.
 */
export interface PeerLink {
  isConnected(): boolean
  sendControl(message: ControlMessage): Promise<void>
  sendChunk(frame: Bytes): Promise<void>
}
