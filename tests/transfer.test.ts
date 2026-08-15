import {describe, expect, it} from 'vitest'
import type {Bytes} from '../src/lib/core/bytes.ts'
import {CHUNK_SIZE} from '../src/lib/core/config.ts'
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
  /** Set to corrupt, drop, or intercept a chunk on its way across. */
  onChunk: ((index: number, payload: Bytes) => Bytes | null) | null = null

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
    // Large enough that a byte-interval checkpoint lands before the drop.
    const {file, data} = makeFile(CHUNK_SIZE * 48)
    const wire = start(file)

    await waitFor(() => wire.receiver !== null)

    // Cut the link at a fixed chunk so the test never races the transfer.
    let cut = false
    wire.onChunk = (index, payload) => {
      if (index >= 40 && !cut) {
        cut = true
        wire.drop()
        return null
      }
      return payload
    }

    await wire.receiver!.accept()
    await waitFor(() => wire.sender!.state === 'RECONNECTING')
    const deliveredBeforeDrop = wire.deliveredChunks.length
    wire.deliveredChunks = []

    wire.restore()
    await waitFor(() => wire.sender!.state === 'COMPLETED' && wire.receiver!.state === 'COMPLETED')

    // The whole point: it picked up mid-file rather than starting over.
    const firstAfterResume = Math.min(...wire.deliveredChunks)
    expect(firstAfterResume).toBeGreaterThan(0)
    expect(wire.deliveredChunks.length).toBeLessThan(deliveredBeforeDrop)

    expectSameBytes(new Uint8Array(await wire.receiver!.received!.arrayBuffer()), data)
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
