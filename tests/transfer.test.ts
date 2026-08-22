import {describe, expect, it} from 'vitest'
import type {Bytes} from '../src/lib/core/bytes.ts'
import {
  CHECKPOINT_INTERVAL_BYTES,
  CHUNK_SIZE,
  MAX_IN_FLIGHT_CHUNKS,
  TIMEOUTS
} from '../src/lib/core/config.ts'
import {decodeChunk, encodeChunk} from '../src/lib/protocol/frame.ts'
import type {ControlMessage, TransferOffer} from '../src/lib/protocol/messages.ts'
import {parseControl} from '../src/lib/protocol/validate.ts'
import type {PeerLink} from '../src/lib/transfer/PeerLink.ts'
import {ReceiveTransfer} from '../src/lib/transfer/ReceiveTransfer.ts'
import {SendTransfer} from '../src/lib/transfer/SendTransfer.ts'
import {isTerminal} from '../src/lib/transfer/states.ts'

/**
 * End-to-end harness: a real SendTransfer talking to a real ReceiveTransfer.
 *
 * Everything crosses the wire the way it would in the browser — control
 * messages are JSON round-tripped through the validator, and chunks are
 * encoded and decoded as binary frames — so the test exercises the actual
 * protocol rather than a mocked stand-in.
 */
class Wire {
  connected = true
  receiver: ReceiveTransfer | null = null
  sender: SendTransfer | null = null

  deliveredChunks: number[] = []
  /**
   * Checkpoints the *sender* has actually received, and the furthest one.
   *
   * Not the same as what the receiver has sent: a checkpoint crosses the wire
   * asynchronously, and one still in flight when the link drops is one the
   * sender cannot resume from. Only what has landed here counts.
   */
  checkpointsReceived = 0
  checkpointChunks = 0
  /** Set to corrupt, drop, or intercept a chunk on its way across. */
  onChunk: ((index: number, payload: Bytes) => Bytes | null) | null = null
  /**
   * Set to stall the wire before a chunk crosses.
   *
   * The sender pipelines and the receiver writes through a serial queue, so by
   * default the sender empties the whole file before the receiver has written
   * much of it — the harness has no backpressure, where a real DataChannel has
   * plenty. A test that needs the receiver to keep up says so here.
   */
  holdChunk: ((index: number) => Promise<void>) | null = null

  senderLink: PeerLink = {
    isConnected: () => this.connected,
    sendControl: async msg => {
      if (!this.connected) throw new Error('link down')
      await tick()
      this.#toReceiver(msg)
    },
    sendChunk: async frame => {
      if (!this.connected) throw new Error('link down')
      await tick()
      if (!this.connected) throw new Error('link down')
      const decoded = decodeChunk(frame, CHUNK_SIZE)
      if (!decoded) throw new Error('undecodable frame')

      if (this.holdChunk) await this.holdChunk(decoded.index)
      if (!this.connected) throw new Error('link down')

      let payload: Bytes | null = decoded.payload
      if (this.onChunk) payload = this.onChunk(decoded.index, decoded.payload)
      if (!payload) return // Simulated loss.

      this.deliveredChunks.push(decoded.index)
      const reframed = decodeChunk(encodeChunk(decoded.seq, decoded.index, payload), CHUNK_SIZE)
      if (reframed) this.receiver?.handleChunk(reframed.index, reframed.payload)
    }
  }

  receiverLink: PeerLink = {
    isConnected: () => this.connected,
    sendControl: async msg => {
      if (!this.connected) throw new Error('link down')
      await tick()
      this.#toSender(msg)
    },
    sendChunk: async () => {
      throw new Error('receiver does not send chunks')
    }
  }

  #toReceiver(msg: ControlMessage): void {
    const parsed = parseControl(JSON.parse(JSON.stringify(msg)))
    if (!parsed.ok) throw new Error(`sender emitted an invalid message: ${parsed.reason}`)

    if (parsed.message.t === 'TRANSFER_OFFER') {
      this.receiver = new ReceiveTransfer({
        offer: parsed.message as TransferOffer,
        peerId: 'peer-a',
        peerName: 'Test device',
        link: this.receiverLink,
        onChange: () => {},
        storagePrefs: {alwaysChooseLocation: false},
        reserveName: name => name
      })
      return
    }
    this.receiver?.handleMessage(parsed.message)
  }

  #toSender(msg: ControlMessage): void {
    const parsed = parseControl(JSON.parse(JSON.stringify(msg)))
    if (!parsed.ok) throw new Error(`receiver emitted an invalid message: ${parsed.reason}`)
    if (parsed.message.t === 'TRANSFER_CHECKPOINT') {
      this.checkpointsReceived++
      this.checkpointChunks = Math.max(this.checkpointChunks, parsed.message.chunks)
    }
    this.sender?.handleMessage(parsed.message)
  }

  drop(): void {
    this.connected = false
    this.sender?.onPeerLost()
    this.receiver?.onPeerLost()
  }

  restore(): void {
    this.connected = true
    this.receiver?.onPeerRestored()
    this.sender?.onPeerRestored()
  }

  /**
   * The link drops for real, but only the receiver is *told* about it.
   *
   * The sender still works it out for itself — its in-flight sends fail and it
   * rewinds into RECONNECTING — but it never gets the `onPeerRestored` callback
   * that would make it renegotiate, because nothing above its transport noticed
   * the peer go and come back. That asymmetry is the deadlock: both ends are
   * waiting, and under the old protocol only the sender was allowed to break
   * the tie.
   */
  dropTellingOnlyReceiver(): void {
    this.connected = false
    this.receiver?.onPeerLost()
  }

  restoreTellingOnlyReceiver(): void {
    this.connected = true
    this.receiver?.onPeerRestored()
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

/**
 * Byte-for-byte comparison. Deliberately not `toEqual`: on a multi-megabyte
 * typed array that walks every element in JS and takes tens of seconds.
 */
function expectSameBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.byteLength).toBe(expected.byteLength)
  expect(Buffer.compare(Buffer.from(actual), Buffer.from(expected))).toBe(0)
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function makeFile(bytes: number, name = 'test.bin'): {file: File; data: Uint8Array} {
  const data = new Uint8Array(bytes)
  // Deterministic but non-uniform, so a misplaced chunk cannot go unnoticed.
  for (let i = 0; i < bytes; i++) data[i] = (i * 31 + (i >> 8) * 17) & 0xff
  return {file: new File([data], name, {lastModified: 1700000000000}), data}
}

function start(file: File): Wire {
  const wire = new Wire()
  wire.sender = new SendTransfer({
    id: 'transfer1',
    seq: 7,
    peerId: 'peer-b',
    peerName: 'Test device',
    file,
    link: wire.senderLink,
    onChange: () => {}
  })
  void wire.sender.start()
  return wire
}

describe('transfer end to end', () => {
  it('sends, verifies and reassembles a multi-chunk file', async () => {
    const {file, data} = makeFile(CHUNK_SIZE * 3 + 1234)
    const wire = start(file)

    await waitFor(() => wire.receiver !== null)
    expect(wire.receiver!.state).toBe('WAITING_FOR_ACCEPT')
    expect(wire.receiver!.size).toBe(file.size)

    await wire.receiver!.accept()
    await waitFor(() => wire.sender!.state === 'COMPLETED' && wire.receiver!.state === 'COMPLETED')

    expect(wire.sender!.verified).toBe(true)
    expect(wire.receiver!.verified).toBe(true)

    const blob = wire.receiver!.received
    expect(blob).not.toBeNull()
    expectSameBytes(new Uint8Array(await blob!.arrayBuffer()), data)
  })

  it('handles an empty file', async () => {
    const {file} = makeFile(0, 'empty.txt')
    const wire = start(file)
    await waitFor(() => wire.receiver !== null)
    await wire.receiver!.accept()
    await waitFor(() => wire.sender!.state === 'COMPLETED' && wire.receiver!.state === 'COMPLETED')
    expect((await wire.receiver!.received!.arrayBuffer()).byteLength).toBe(0)
  })

  it('resumes from the last checkpoint instead of restarting', async () => {
    // Long enough for a second checkpoint, short enough that the stretch after
    // it is clearly shorter than the stretch before.
    const chunksPerCheckpoint = CHECKPOINT_INTERVAL_BYTES / CHUNK_SIZE
    const {file, data} = makeFile(CHUNK_SIZE * (chunksPerCheckpoint + 16))
    const wire = start(file)

    await waitFor(() => wire.receiver !== null)

    // Stall the sender partway and wait for a checkpoint to reach it.
    //
    // Left to itself the sender empties the whole file before the receiver's
    // write queue has drained far enough to acknowledge anything, so no useful
    // checkpoint ever arrives — the condition the old fixed-index cut was
    // silently gambling on. Stalling cannot deadlock: the receiver keeps
    // draining what it already holds, which is what produces the checkpoint.
    // By this index it holds well over the byte interval, so one is guaranteed.
    const holdFrom = chunksPerCheckpoint + MAX_IN_FLIGHT_CHUNKS
    wire.holdChunk = async index => {
      if (index < holdFrom) return
      // Releasing on disconnect matters as much as the wait: the receiver stops
      // writing the moment the link is cut, so a chunk parked here would wait
      // forever and the sends holding the in-flight window would never fail,
      // leaving the sender unable to resume. A dropped link fails its sends.
      await waitFor(() => !wire.connected || wire.checkpointsReceived >= 2, 5_000)
    }

    // Cut once the sender is holding the *second* checkpoint, rather than at a
    // fixed chunk index. The old version cut at chunk 40 and assumed a useful
    // checkpoint had arrived by then; about one run in thirty it had not, the
    // sender fell back to the first one, and resent nearly the whole file.
    //
    // Counting checkpoints rather than testing their value is deliberate. The
    // first is emitted on the very first chunk, because lastCheckpointAt starts
    // at zero and any elapsed time beats the interval, so it covers ~1 chunk and
    // is no use to resume from. The second is the first real one. Its exact
    // value can't be predicted either: it reports *contiguous* chunks, which
    // trails what has been written by the size of the in-flight window.
    let cut = false
    wire.onChunk = (_index, payload) => {
      if (!cut && wire.checkpointsReceived >= 2) {
        cut = true
        wire.drop()
        return null
      }
      return payload
    }

    await wire.receiver!.accept()
    // COMPLETED is included so that running out of file fails here, loudly and
    // at once, instead of hanging until the suite timeout.
    await waitFor(() => wire.sender!.state === 'RECONNECTING' || wire.sender!.state === 'COMPLETED')
    expect(cut, 'transfer finished before a checkpoint reached the sender').toBe(true)
    expect(wire.sender!.state).toBe('RECONNECTING')

    const deliveredBeforeDrop = wire.deliveredChunks.length
    const resumeFrom = wire.checkpointChunks
    wire.deliveredChunks = []

    // The stall has done its job; the resumed leg runs at full speed.
    wire.holdChunk = null
    wire.restore()
    await waitFor(() => wire.sender!.state === 'COMPLETED' && wire.receiver!.state === 'COMPLETED')

    // The whole point: it picked up mid-file rather than starting over.
    const firstAfterResume = Math.min(...wire.deliveredChunks)
    expect(firstAfterResume).toBeGreaterThan(0)
    // Nothing below the checkpoint is sent twice — that is what a checkpoint is.
    expect(firstAfterResume).toBeGreaterThanOrEqual(resumeFrom)
    expect(wire.deliveredChunks.length).toBeLessThan(deliveredBeforeDrop)

    expectSameBytes(new Uint8Array(await wire.receiver!.received!.arrayBuffer()), data)
  })

  it('lets the receiver restart a transfer the sender was never told had dropped', async () => {
    // Comfortably more chunks than the in-flight window, so the sender is
    // genuinely mid-stream when the link goes rather than already drained.
    const {file, data} = makeFile(CHUNK_SIZE * (MAX_IN_FLIGHT_CHUNKS * 4))
    const wire = start(file)
    await waitFor(() => wire.receiver !== null)

    // Throttle so the sender cannot empty the file before the cut. Released on
    // disconnect, or the parked chunk would wait forever and the in-flight
    // window would never fail.
    wire.holdChunk = async index => {
      if (index < MAX_IN_FLIGHT_CHUNKS) return
      await waitFor(() => !wire.connected, 5_000)
    }

    await wire.receiver!.accept()
    await waitFor(() => wire.deliveredChunks.length >= 2)

    wire.dropTellingOnlyReceiver()
    await waitFor(() => wire.receiver!.state === 'RECONNECTING')
    await waitFor(() => wire.sender!.state === 'RECONNECTING')

    // Both ends are stalled, and the sender will never be told the peer is
    // back. Under the old protocol that deadlocked: the sender drove resume,
    // so nobody sent TRANSFER_RESUME and the receiver waited for a message
    // that could not arrive. The receiver's own checkpoint has to restart it.
    wire.holdChunk = null
    wire.restoreTellingOnlyReceiver()
    await waitFor(() => wire.sender!.state === 'COMPLETED' && wire.receiver!.state === 'COMPLETED')

    expect(wire.receiver!.verified).toBe(true)
    expectSameBytes(new Uint8Array(await wire.receiver!.received!.arrayBuffer()), data)
  })

  it('bounds a reconnect from the first drop, however often the peer flaps', async () => {
    const {file} = makeFile(CHUNK_SIZE * 4)
    const wire = start(file)
    await waitFor(() => wire.receiver !== null)
    await wire.receiver!.accept()
    await waitFor(() => wire.deliveredChunks.length >= 1)

    const receiver = wire.receiver!
    // Nothing reaches the receiver from here on, so no bounce ever produces bytes.
    wire.onChunk = () => null
    const firstDrop = Date.now()
    receiver.onPeerLost()
    expect(receiver.state).toBe('RECONNECTING')

    // The peer reappears and vanishes repeatedly. Every reappearance used to
    // refresh lastActivity, which the reconnect window was measured from — so
    // a flapping peer reset the clock forever and the transfer hung in
    // RECONNECTING instead of failing.
    for (let i = 1; i <= 5; i++) {
      receiver.onPeerRestored()
      await tick()
      receiver.onPeerLost()
      receiver.checkStall(firstDrop + i * 1000)
      expect(receiver.state, `gave up early on bounce ${i}`).toBe('RECONNECTING')
    }

    receiver.checkStall(firstDrop + TIMEOUTS.reconnectWindowMs + 1)
    expect(receiver.state).toBe('FAILED')
  })

  it('survives duplicated chunks without corrupting the file', async () => {
    const {file, data} = makeFile(CHUNK_SIZE * 3)
    const wire = start(file)
    await waitFor(() => wire.receiver !== null)

    // Deliver every chunk twice, as a resume overlap would.
    const original = wire.senderLink.sendChunk.bind(wire.senderLink)
    wire.senderLink.sendChunk = async frame => {
      await original(frame)
      await original(frame)
    }

    await wire.receiver!.accept()
    await waitFor(() => wire.sender!.state === 'COMPLETED' && wire.receiver!.state === 'COMPLETED')
    expectSameBytes(new Uint8Array(await wire.receiver!.received!.arrayBuffer()), data)
  })

  it('fails verification on a corrupted chunk and refuses to save the file', async () => {
    const {file} = makeFile(CHUNK_SIZE * 3)
    const wire = start(file)
    await waitFor(() => wire.receiver !== null)

    wire.onChunk = (index, payload) => {
      if (index !== 1) return payload
      const tampered = payload.slice()
      tampered[0] = tampered[0]! ^ 0xff
      return tampered
    }

    await wire.receiver!.accept()
    await waitFor(() => isTerminal(wire.receiver!.state) && isTerminal(wire.sender!.state))

    expect(wire.receiver!.state).toBe('FAILED')
    expect(wire.receiver!.error?.code).toBe('integrity-failed')
    // An unverified file is never handed to the user.
    expect(wire.receiver!.received).toBeNull()
    expect(wire.sender!.state).toBe('FAILED')
  })

  it('rejects a chunk whose length contradicts the offer', async () => {
    const {file} = makeFile(CHUNK_SIZE * 2)
    const wire = start(file)
    await waitFor(() => wire.receiver !== null)
    await wire.receiver!.accept()
    await waitFor(() => wire.receiver!.state === 'TRANSFERRING')

    // A short payload for a non-final chunk is a protocol violation.
    wire.receiver!.handleChunk(0, new Uint8Array(64))
    await waitFor(() => isTerminal(wire.receiver!.state))
    expect(wire.receiver!.state).toBe('FAILED')
    expect(wire.receiver!.error?.code).toBe('protocol-violation')
  })

  it('propagates a rejection back to the sender', async () => {
    const {file} = makeFile(CHUNK_SIZE)
    const wire = start(file)
    await waitFor(() => wire.receiver !== null)
    await wire.receiver!.reject()
    await waitFor(() => wire.sender!.state === 'REJECTED')
    expect(wire.receiver!.state).toBe('REJECTED')
    expect(wire.deliveredChunks).toHaveLength(0)
  })

  it('refuses to resume when the file no longer matches', async () => {
    const {file} = makeFile(CHUNK_SIZE * 4)
    const wire = start(file)
    await waitFor(() => wire.receiver !== null)
    await wire.receiver!.accept()
    await waitFor(() => wire.deliveredChunks.length >= 1)

    // The sender now claims a different file under the same transfer id.
    wire.receiver!.handleMessage({
      v: 1,
      t: 'TRANSFER_RESUME',
      transferId: 'transfer1',
      identity: {size: 999, lastModified: 1, chunkSize: CHUNK_SIZE}
    })

    await waitFor(() => isTerminal(wire.receiver!.state))
    expect(wire.receiver!.state).toBe('FAILED')
    expect(wire.receiver!.error?.code).toBe('resume-mismatch')
  })

  it('cancels cleanly from the receiver', async () => {
    const {file} = makeFile(CHUNK_SIZE * 20)
    const wire = start(file)
    await waitFor(() => wire.receiver !== null)
    await wire.receiver!.accept()
    await waitFor(() => wire.deliveredChunks.length >= 2)

    wire.receiver!.cancel()
    await waitFor(() => wire.sender!.state === 'CANCELLED')
    expect(wire.receiver!.state).toBe('CANCELLED')
    expect(wire.receiver!.received).toBeNull()
  })
})
