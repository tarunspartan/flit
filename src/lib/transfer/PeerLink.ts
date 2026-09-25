import type {Bytes} from '../core/bytes.ts'
import type {ControlMessage} from '../protocol/messages.ts'

export interface SendControlOptions {
  /**
   * Deliver after every chunk already sent to this peer, rather than possibly
   * ahead of them. Only TRANSFER_COMPLETE needs it: it is the one message that
   * makes a claim about chunks.
   */
  afterChunks?: boolean
}

/**
 * What a transfer is allowed to know about the connection: how to send, and
 * whether the peer is currently reachable. No peer ids, no channels, no ICE.
 */
export interface PeerLink {
  isConnected(): boolean
  sendControl(message: ControlMessage, options?: SendControlOptions): Promise<void>
  sendChunk(frame: Bytes): Promise<void>
  /**
   * The largest binary frame the link carries as a single message. Chunks are
   * sized to fit, so none has to be split and reassembled on the way. Absent
   * means no limit worth sizing for.
   */
  maxFrameBytes?(): number
}
