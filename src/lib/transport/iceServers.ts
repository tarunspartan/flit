import {STUN_URLS} from '../core/config.ts'

/**
 * ICE configuration.
 *
 * STUN only, by design: no TURN means no relay to run, pay for, or keep alive.
 * See STUN_URLS in config.ts for the trade-off this accepts.
 */
export function resolveIceServers(localOnly = false): RTCIceServer[] {
  // Local-network-only mode: with no STUN at all the browser can only offer
  // host candidates, so a connection either stays on the local network or fails
  // visibly — it can never quietly leave it.
  if (localOnly) return []
  return [{urls: STUN_URLS}]
}
