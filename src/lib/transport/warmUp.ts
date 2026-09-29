/**
 * Brings a fresh connection up to speed before anyone needs it to be.
 *
 * A new WebRTC connection starts slow and ramps up as its congestion window
 * grows: measured between two Chromes on one network, the first file sent on
 * a new connection moved at about 2 MB/s for its first two and a half seconds
 * and only then jumped to 35–40 MB/s. The disk and the pipeline were idle the
 * whole time — the bytes simply were not being let onto the wire any faster.
 * Every later transfer on the same connection starts at full speed. So the
 * first file you send paid for the connection's ramp, and the speed readout
 * made it look like the app was slow to get going.
 *
 * The fix is to pay that cost before the first file does: as soon as a
 * connection is known to be on the local network, push a few megabytes of
 * filler across it. On a LAN or a hotspot that costs nothing but a moment of
 * idle Wi-Fi; over the internet it would spend someone's mobile data, so it
 * never runs there, and those links keep the ramp.
 *
 * The filler rides a lane of its own, stream 17, created on both ends with a
 * fixed id and never read. A peer on an older build has no channel on that
 * stream, and its browser drops what arrives there — the bytes still cross
 * the network, which is all the warm-up needs.
 */

export const WARMUP_CHANNEL_ID = 17
const LABEL = 'flit-warmup'

/** Enough to take the window from its opening size to full speed on a LAN. */
const WARMUP_BYTES = 6 * 1024 * 1024
const PIECE_BYTES = 256 * 1024

/** Opens the warm-up lane on a connection. The far end's copy only ever soaks up. */
export function openWarmUpLane(pc: RTCPeerConnection): RTCDataChannel | null {
  try {
    const channel = pc.createDataChannel(LABEL, {
      negotiated: true,
      id: WARMUP_CHANNEL_ID,
      // Filler: nothing is gained by resending a lost piece or keeping order.
      ordered: false,
      maxRetransmits: 0
    })
    // Never read, but a Blob per message would still be allocated for it.
    channel.binaryType = 'arraybuffer'
    return channel
  } catch {
    return null
  }
}

/** Sends the filler once the lane is open. Best effort: a closed lane simply isn't warmed. */
export function warmUp(channel: RTCDataChannel, maxMessageSize: number | undefined): void {
  const size = Math.min(PIECE_BYTES, maxMessageSize && maxMessageSize > 0 ? maxMessageSize : 64 * 1024)
  const send = () => {
    const piece = new Uint8Array(size)
    try {
      for (let sent = 0; sent < WARMUP_BYTES; sent += size) channel.send(piece)
    } catch {
      // The connection went while filling; there is nothing left to warm.
    }
  }
  if (channel.readyState === 'open') send()
  else channel.addEventListener('open', send, {once: true})
}
