import {afterEach, describe, expect, it, vi} from 'vitest'
import type {Bytes} from '../src/lib/core/bytes.ts'
import {
  CHECKPOINT_INTERVAL_BYTES,
  CHUNK_SIZE,
  MAX_IN_FLIGHT_CHUNKS,
  TIMEOUTS
} from '../src/lib/core/config.ts'
import {decodeChunk, encodeChunk} from '../src/lib/protocol/frame.ts'
import {ChunkTreeHasher} from '../src/lib/integrity/hash.ts'
import {message, type ControlMessage, type TransferOffer} from '../src/lib/protocol/messages.ts'
import {parseControl} from '../src/lib/protocol/validate.ts'
import {MemoryStore} from '../src/lib/storage/MemoryStore.ts'
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
  /** Set to lose a control message on its way to the receiver or the sender. */
  loseToReceiver: ((msg: ControlMessage) => boolean) | null = null
  loseToSender: ((msg: ControlMessage) => boolean) | null = null
  /** Set to deliver a control message to the receiver twice, back to back. */
  doubleToReceiver: ((msg: ControlMessage) => boolean) | null = null

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
    if (this.loseToReceiver?.(parsed.message)) return
    if (this.doubleToReceiver?.(parsed.message)) {
      this.doubleToReceiver = null
      this.#toReceiver(msg)
    }

    if (parsed.message.t === 'TRANSFER_OFFER') {
      // A repeated offer reaches the transfer that already exists, as it does
      // through TransferManager.
      if (this.receiver?.id === parsed.message.transferId) {
        this.receiver.onOfferRepeated()
        return
      }
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
    if (this.loseToSender?.(parsed.message)) return
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

  /** A connection blip: both ends see the peer go and come straight back. */
  blip(): void {
    this.drop()
    this.restore()
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

/**
 * Parks every chunk from `index` on in the wire until released, so a test can
 * stage something mid-transfer without racing the transfer to its end.
 */
function holdFrom(wire: Wire, index: number): {release: () => void} {
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  wire.holdChunk = chunk => (chunk >= index ? gate : Promise.resolve())
  return {release}
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

  it('does not count a frozen page as a stalled transfer', async () => {
    const {file} = makeFile(CHUNK_SIZE * 4)
    const wire = start(file)
    await waitFor(() => wire.receiver !== null)

    // Hold the wire open so the transfer stays mid-flight for the whole test.
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    wire.holdChunk = index => (index >= 2 ? gate : Promise.resolve())

    await wire.receiver!.accept()
    await waitFor(() => wire.receiver!.state === 'TRANSFERRING')
    const receiver = wire.receiver!

    // A phone that locked for twice the stall window. Wall-clock moved a long
    // way; nothing in the page ran, so the link proved nothing either way.
    const frozen = TIMEOUTS.transferStallMs * 2
    receiver.lastActivity -= frozen
    receiver.creditFrozen(frozen)
    receiver.checkStall()
    expect(receiver.state).toBe('TRANSFERRING')

    // The same silence while the page *was* running is a real stall, and must
    // still be caught — otherwise the credit would have disarmed the watchdog.
    receiver.lastActivity -= frozen
    receiver.checkStall()
    expect(receiver.state).toBe('FAILED')
    expect(receiver.error?.code).toBe('transfer-stalled')

    release()
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
    const chunksPerCheckpoint = Math.ceil(CHECKPOINT_INTERVAL_BYTES / CHUNK_SIZE)
    // Where the stall begins: past the first checkpoint plus a full in-flight
    // window, so the receiver has certainly acknowledged something by then.
    const holdFrom = chunksPerCheckpoint + MAX_IN_FLIGHT_CHUNKS
    // The file has to outlast that point by another checkpoint's worth, or the
    // sender runs out of file before a second checkpoint arrives and there is
    // nothing left to cut. Derived from the config rather than a fixed +16:
    // doubling CHUNK_SIZE halves chunksPerCheckpoint while doubling the
    // in-flight window, which walked holdFrom exactly onto the last chunk and
    // the stall never engaged at all.
    const {file, data} = makeFile(CHUNK_SIZE * (holdFrom + chunksPerCheckpoint + 8))
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

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
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
    // Resumed rather than restarted, stated as the invariant rather than as
    // "the second leg is shorter than the first" — that comparison depended on
    // where the cut landed relative to the file's length and broke as soon as
    // the chunk size changed, though resume was working perfectly.
    //
    // Distinct chunks, not raw sends: a few above the checkpoint legitimately
    // cross twice, because the sender rewinds its own failed in-flight sends
    // before the receiver's resume point arrives. §Invariants 1 says duplicates
    // are safe, so counting them here would have this test contradict the
    // protocol it is checking — which it did, on 7 runs in 30.
    const distinctAfterResume = new Set(wire.deliveredChunks).size
    expect(distinctAfterResume).toBeLessThanOrEqual(totalChunks - resumeFrom)

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
    // Held mid-file, so the transfer cannot finish before the drop is staged.
    const hold = holdFrom(wire, 1)
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

    // A second past the window, not a millisecond: the drop is stamped inside
    // onPeerLost, which can land a tick after firstDrop was read.
    receiver.checkStall(firstDrop + TIMEOUTS.reconnectWindowMs + 1000)
    expect(receiver.state).toBe('FAILED')
    hold.release()
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

  it('starts the stall clock when a file is accepted, not when it was offered', async () => {
    const {file, data} = makeFile(CHUNK_SIZE * 2)
    const wire = start(file)
    await waitFor(() => wire.receiver !== null)
    // Offered well over a stall window ago, and only accepted now — while the
    // sender has not yet sent a chunk, as when it is busy with the file ahead
    // of this one in the same batch.
    wire.receiver!.lastActivity = Date.now() - TIMEOUTS.transferStallMs - 10_000
    const hold = holdFrom(wire, 0)
    await wire.receiver!.accept()
    wire.receiver!.tick(Date.now())
    expect(wire.receiver!.state).toBe('TRANSFERRING')

    hold.release()
    await waitFor(() => wire.receiver!.state === 'COMPLETED')
    expectSameBytes(new Uint8Array(await wire.receiver!.received!.arrayBuffer()), data)
  })

  it('tells the sender when it gives up on a stalled transfer', async () => {
    const {file} = makeFile(CHUNK_SIZE * 2)
    const wire = start(file)
    await waitFor(() => wire.receiver !== null)
    const hold = holdFrom(wire, 0)
    await wire.receiver!.accept()
    wire.receiver!.checkStall(Date.now() + TIMEOUTS.transferStallMs + 1)
    expect(wire.receiver!.state).toBe('FAILED')
    await waitFor(() => isTerminal(wire.sender!.state))
    expect(wire.sender!.state).toBe('FAILED')
    hold.release()
  })

  it('rejects a chunk whose length contradicts the offer', async () => {
    const {file} = makeFile(CHUNK_SIZE * 2)
    const wire = start(file)
    await waitFor(() => wire.receiver !== null)
    const hold = holdFrom(wire, 0)
    await wire.receiver!.accept()
    await waitFor(() => wire.receiver!.state === 'TRANSFERRING')

    // A short payload for a non-final chunk is a protocol violation.
    wire.receiver!.handleChunk(0, new Uint8Array(64))
    await waitFor(() => isTerminal(wire.receiver!.state))
    expect(wire.receiver!.state).toBe('FAILED')
    expect(wire.receiver!.error?.code).toBe('protocol-violation')
    hold.release()
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
    const hold = holdFrom(wire, 1)
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
    hold.release()
  })

  it('cancels cleanly from the receiver', async () => {
    const {file} = makeFile(CHUNK_SIZE * 20)
    const wire = start(file)
    await waitFor(() => wire.receiver !== null)
    // Held mid-file: under load the whole file could otherwise land between
    // two polls, leaving nothing in flight to cancel.
    const hold = holdFrom(wire, 4)
    await wire.receiver!.accept()
    await waitFor(() => wire.deliveredChunks.length >= 2)

    wire.receiver!.cancel()
    await waitFor(() => wire.sender!.state === 'CANCELLED')
    expect(wire.receiver!.state).toBe('CANCELLED')
    expect(wire.receiver!.received).toBeNull()
    hold.release()
  })
})

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** What arrives at a sender, built as the receiver would send it. */
function accept(transferId: string, fromChunk: number, missing?: [number, number][]): ControlMessage {
  return message({t: 'TRANSFER_ACCEPT', transferId, fromChunk, ...(missing ? {missing} : {})})
}

/**
 * Each of these reproduced a transfer that failed, hung, or did the wrong
 * thing under a condition that happens in normal use — a network blip, a lost
 * message, a slow disk. They run against the same wire as the tests above.
 */
describe('recovery', () => {
  // Unconditionally: a spy left behind by a failed assertion would be taken for
  // the original by the next test, which then calls itself until memory runs out.
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps an offer alive across a blip before anyone presses Download', async () => {
    // The sender used to move an unaccepted offer into RECONNECTING, ask the
    // receiver to resume a transfer it had never agreed to, get no answer, and
    // fail it two minutes later — while the receiver still showed Download.
    const {file, data} = makeFile(CHUNK_SIZE * 2)
    const wire = start(file)
    await waitFor(() => wire.receiver !== null)

    wire.blip()
    await sleep(20)
    expect(wire.sender!.state).toBe('WAITING_FOR_ACCEPT')
    // An offer has no deadline, however long the user takes.
    wire.sender!.tick(Date.now() + TIMEOUTS.reconnectWindowMs + 1)
    expect(wire.sender!.state).toBe('WAITING_FOR_ACCEPT')

    await wire.receiver!.accept()
    await waitFor(() => wire.sender!.state === 'COMPLETED' && wire.receiver!.state === 'COMPLETED')
    expectSameBytes(new Uint8Array(await wire.receiver!.received!.arrayBuffer()), data)
  })

  it('never completes an empty file the receiver did not accept', async () => {
    // With zero chunks the sender's hash is complete from the start, so a blip
    // used to announce completion for a file nobody had said yes to.
    const wire = start(makeFile(0, 'empty.txt').file)
    await waitFor(() => wire.receiver !== null)

    wire.blip()
    await sleep(20)
    expect(wire.sender!.state).toBe('WAITING_FOR_ACCEPT')
    expect(wire.receiver!.state).toBe('WAITING_FOR_ACCEPT')

    await wire.receiver!.accept()
    await waitFor(() => wire.sender!.state === 'COMPLETED' && wire.receiver!.state === 'COMPLETED')
  })

  it('says the file could not be read, on both ends, when it vanishes mid-send', async () => {
    // Was reported as a lost connection after sitting two minutes in
    // RECONNECTING, while the receiver gave up as "stalled".
    const good = makeFile(CHUNK_SIZE * 3).file
    const vanishing = new Proxy(good, {
      get(target, prop) {
        if (prop === 'slice') {
          return (from: number, to: number) =>
            from >= CHUNK_SIZE
              ? {arrayBuffer: () => Promise.reject(new DOMException('gone', 'NotReadableError'))}
              : target.slice(from, to)
        }
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    }) as File

    const wire = start(vanishing)
    await waitFor(() => wire.receiver !== null)
    await wire.receiver!.accept()
    await waitFor(() => isTerminal(wire.sender!.state) && isTerminal(wire.receiver!.state))

    expect(wire.sender!.error?.code).toBe('file-unreadable')
    expect(wire.receiver!.error?.code).toBe('file-unreadable')
    expect(wire.receiver!.received).toBeNull()
  })

  it('finalizes once when the completion arrives twice', async () => {
    // Two overlapping verifications each finalized — and downloaded — the file.
    const finalize = vi.spyOn(MemoryStore.prototype, 'finalize')
    const wire = start(makeFile(CHUNK_SIZE * 2 + 10).file)
    wire.doubleToReceiver = msg => msg.t === 'TRANSFER_COMPLETE'
    await waitFor(() => wire.receiver !== null)
    await wire.receiver!.accept()
    await waitFor(() => wire.sender!.state === 'COMPLETED' && wire.receiver!.state === 'COMPLETED')
    await sleep(20)
    expect(finalize).toHaveBeenCalledTimes(1)
  })

  it('does not call a slow save a stall', async () => {
    // The verdict goes out before the file is saved, so the sender was already
    // done while the receiver's watchdog failed a multi-gigabyte close() that
    // simply took longer than the stall window.
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    const original = MemoryStore.prototype.finalize
    vi.spyOn(MemoryStore.prototype, 'finalize').mockImplementation(async function (this: MemoryStore) {
      await gate
      return original.call(this)
    })

    const wire = start(makeFile(CHUNK_SIZE * 2).file)
    await waitFor(() => wire.receiver !== null)
    await wire.receiver!.accept()
    await waitFor(() => wire.sender!.state === 'COMPLETED')
    expect(wire.receiver!.state).toBe('VERIFYING')

    wire.receiver!.checkStall(Date.now() + TIMEOUTS.transferStallMs + 1)
    expect(wire.receiver!.state).toBe('VERIFYING')

    release()
    await waitFor(() => wire.receiver!.state === 'COMPLETED')
  })

  it('resends only the chunk that was lost', async () => {
    // A single gap used to rewind the sender to it and resend everything after.
    const total = 12
    const {file, data} = makeFile(CHUNK_SIZE * total)
    const wire = start(file)
    let lost = false
    wire.onChunk = (index, payload) => {
      if (index === 2 && !lost) {
        lost = true
        return null
      }
      return payload
    }
    await waitFor(() => wire.receiver !== null)
    await wire.receiver!.accept()
    await waitFor(() => wire.sender!.state === 'COMPLETED' && wire.receiver!.state === 'COMPLETED')

    expect(lost).toBe(true)
    expect(wire.deliveredChunks).toHaveLength(total)
    expect(new Set(wire.deliveredChunks).size).toBe(total)
    expectSameBytes(new Uint8Array(await wire.receiver!.received!.arrayBuffer()), data)
  })

  it('keeps every chunk it already has when the connection drops', async () => {
    // Resuming used to throw away everything above the last contiguous
    // checkpoint, including chunks that had been written and flushed.
    const total = 12
    const {file, data} = makeFile(CHUNK_SIZE * total)
    const wire = start(file)
    // One early chunk goes missing, so what the receiver holds has a hole in it
    // — everything above the hole is what the old resume threw away.
    let holed = false
    wire.onChunk = (index, payload) => {
      if (index !== 1 || holed) return payload
      holed = true
      return null
    }
    await waitFor(() => wire.receiver !== null)
    const hold = holdFrom(wire, 8)
    await wire.receiver!.accept()
    await waitFor(() => wire.deliveredChunks.length >= 7)
    wire.drop()
    hold.release()
    await sleep(20)
    const before = new Set(wire.deliveredChunks)
    wire.deliveredChunks = []
    wire.holdChunk = null
    wire.restore()
    await waitFor(() => wire.sender!.state === 'COMPLETED' && wire.receiver!.state === 'COMPLETED')

    // Nothing that had already arrived crossed the wire again.
    for (const index of wire.deliveredChunks) expect(before.has(index)).toBe(false)
    expect(before.size + new Set(wire.deliveredChunks).size).toBe(total)
    expectSameBytes(new Uint8Array(await wire.receiver!.received!.arrayBuffer()), data)
  })

  it('asks again when its go-ahead is lost', async () => {
    const {file, data} = makeFile(CHUNK_SIZE * 3)
    const wire = start(file)
    let lost = false
    wire.loseToSender = msg => {
      if (msg.t !== 'TRANSFER_ACCEPT' || lost) return false
      lost = true
      return true
    }
    await waitFor(() => wire.receiver !== null)
    await wire.receiver!.accept()
    await sleep(20)
    expect(wire.deliveredChunks).toHaveLength(0)
    expect(wire.sender!.state).toBe('WAITING_FOR_ACCEPT')

    // The receiver notices the silence and asks for what it is missing.
    wire.receiver!.tick(Date.now() + TIMEOUTS.retryMs + 1)
    await waitFor(() => wire.sender!.state === 'COMPLETED' && wire.receiver!.state === 'COMPLETED')
    expectSameBytes(new Uint8Array(await wire.receiver!.received!.arrayBuffer()), data)
  })

  it('announces completion again when the first announcement is lost', async () => {
    const wire = start(makeFile(CHUNK_SIZE * 3).file)
    let lost = false
    wire.loseToReceiver = msg => {
      if (msg.t !== 'TRANSFER_COMPLETE' || lost) return false
      lost = true
      return true
    }
    await waitFor(() => wire.receiver !== null)
    await wire.receiver!.accept()
    await waitFor(() => lost && wire.sender!.state === 'VERIFYING')
    await sleep(20)
    expect(wire.receiver!.state).toBe('TRANSFERRING')

    wire.sender!.tick(Date.now() + TIMEOUTS.retryMs + 1)
    await waitFor(() => wire.sender!.state === 'COMPLETED' && wire.receiver!.state === 'COMPLETED')
  })

  it('repeats a decision the sender never heard', async () => {
    const wire = start(makeFile(CHUNK_SIZE).file)
    await waitFor(() => wire.receiver !== null)
    wire.loseToSender = msg => msg.t === 'TRANSFER_REJECT'
    await wire.receiver!.reject()
    expect(wire.sender!.state).toBe('WAITING_FOR_ACCEPT')

    // Reconnecting re-offers; the receiver answers with the decline it made.
    wire.loseToSender = null
    wire.blip()
    await waitFor(() => wire.sender!.state === 'REJECTED')
  })
})

describe('the sending side', () => {
  /** A link that records what it is handed and parks chunks at and above `holdAt`. */
  function recordingLink(holdAt: number) {
    const sent: number[] = []
    const parked = new Map<number, () => void>()
    const link: PeerLink = {
      isConnected: () => true,
      sendControl: async () => {},
      sendChunk: async frame => {
        const index = decodeChunk(frame, CHUNK_SIZE)!.index
        if (index >= holdAt) await new Promise<void>(resolve => parked.set(index, resolve))
        sent.push(index)
      }
    }
    return {link, sent, parked}
  }

  it('does not resend what is already on its way when the receiver nudges', async () => {
    // A receiver hears nothing for a while and asks for everything it lacks.
    // Mid-stream, most of that is simply in flight; resending it would double
    // the traffic on exactly the slow links where the nudge happens.
    const total = 12
    const {link, sent, parked} = recordingLink(4)
    const sender = new SendTransfer({
      id: 'nudged', seq: 1, peerId: 'p', peerName: 'P',
      file: makeFile(CHUNK_SIZE * total).file, link, onChange: () => {}
    })
    await sender.start()
    sender.handleMessage(accept('nudged', 0))
    await waitFor(() => sent.length === 4 && parked.size === MAX_IN_FLIGHT_CHUNKS)

    sender.handleMessage(accept('nudged', 0, [[0, total]]))
    for (const release of parked.values()) release()
    await waitFor(() => sender.state === 'VERIFYING')

    expect(sent.sort((a, b) => a - b)).toEqual(Array.from({length: total}, (_, i) => i))
  })

  it('hashes a file once however many devices it goes to at once', async () => {
    // Every device in a room used to re-hash the same file from scratch.
    const {file} = makeFile(CHUNK_SIZE * 5)
    const hasher = new ChunkTreeHasher(file.size, CHUNK_SIZE, 5)
    const add = vi.spyOn(hasher, 'add')
    const senders = ['a', 'b', 'c'].map(peer => {
      const {link} = recordingLink(Infinity)
      return new SendTransfer({id: peer, seq: 1, peerId: peer, peerName: peer, file, link, hasher, onChange: () => {}})
    })
    for (const sender of senders) {
      await sender.start()
      sender.handleMessage(accept(sender.id, 0))
    }
    await waitFor(() => senders.every(sender => sender.state === 'VERIFYING'))
    expect(add).toHaveBeenCalledTimes(5)
  })

  it('ignores a failure from a connection it has already given up on', async () => {
    // A send stuck on the old connection failing *after* the transfer had
    // resumed on a new one knocked it straight back into RECONNECTING.
    let failOld!: (err: Error) => void
    let first = true
    const link: PeerLink = {
      isConnected: () => true,
      sendControl: async () => {},
      sendChunk: async () => {
        if (first) {
          first = false
          await new Promise<void>((_, reject) => (failOld = reject))
        }
      }
    }
    const sender = new SendTransfer({
      id: 'stale', seq: 1, peerId: 'p', peerName: 'P',
      file: makeFile(CHUNK_SIZE * 40).file, link, onChange: () => {}
    })
    await sender.start()
    sender.handleMessage(accept('stale', 0))
    await sleep(10)

    sender.onPeerLost()
    sender.onPeerRestored()
    sender.handleMessage(accept('stale', 1))
    expect(sender.state).toBe('TRANSFERRING')
    failOld(new Error('old channel closed'))
    await sleep(10)
    expect(sender.state).not.toBe('RECONNECTING')
  })
})
