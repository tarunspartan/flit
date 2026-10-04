import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {BULK_HIGH_WATER} from '../src/lib/core/config.ts'
import {BULK_HANDSHAKE_MS, BulkChannel, type ChannelLike} from '../src/lib/transport/BulkChannel.ts'

/**
 * A data channel stand-in. Two of them joined with `link` deliver to each
 * other asynchronously, as a real pair would.
 */
class FakeChannel {
  readyState: RTCDataChannelState = 'open'
  bufferedAmount = 0
  bufferedAmountLowThreshold = 0
  binaryType: BinaryType = 'blob'
  onopen: ((event: Event) => void) | null = null
  onclose: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onbufferedamountlow: ((event: Event) => void) | null = null
  peer: FakeChannel | null = null
  sent: (string | ArrayBufferView)[] = []

  send(data: string | ArrayBufferView): void {
    if (this.readyState !== 'open') throw new DOMException('closed', 'InvalidStateError')
    this.sent.push(data)
    const peer = this.peer
    if (!peer) return
    const payload =
      typeof data === 'string'
        ? data
        : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    setTimeout(() => peer.onmessage?.(new MessageEvent('message', {data: payload})), 0)
  }

  close(): void {
    this.readyState = 'closed'
    this.onclose?.(new Event('close'))
  }

  drain(): void {
    this.bufferedAmount = 0
    this.onbufferedamountlow?.(new Event('bufferedamountlow'))
  }
}

const asChannel = (fake: FakeChannel) => fake as unknown as ChannelLike
const noop = {onChunk: () => {}, onControl: () => {}}

function pair() {
  const a = new FakeChannel()
  const b = new FakeChannel()
  a.peer = b
  b.peer = a
  return {a, b}
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('bulk channel', () => {
  it('is used once both ends have said they speak it', async () => {
    const {a, b} = pair()
    const left = new BulkChannel(asChannel(a), noop, 256 * 1024)
    const right = new BulkChannel(asChannel(b), noop, 256 * 1024)
    await vi.advanceTimersByTimeAsync(10)
    expect(await left.ready).toBe(true)
    expect(await right.ready).toBe(true)
    expect(left.maxMessageSize).toBe(256 * 1024)
  })

  it('falls back when the other end never answers', async () => {
    // An older build creates no such channel, so nothing ever says hello back.
    const lonely = new BulkChannel(asChannel(new FakeChannel()), noop)
    await vi.advanceTimersByTimeAsync(BULK_HANDSHAKE_MS + 1)
    expect(await lonely.ready).toBe(false)
  })

  it('still answers a hello that arrives after it settled on the fallback', async () => {
    const {a, b} = pair()
    a.peer = null // our hello is lost
    const early = new BulkChannel(asChannel(a), noop)
    await vi.advanceTimersByTimeAsync(BULK_HANDSHAKE_MS + 1)
    expect(await early.ready).toBe(false)

    a.peer = b
    const late = new BulkChannel(asChannel(b), noop)
    await vi.advanceTimersByTimeAsync(10)
    // The late end can send to us; our own choice stays made.
    expect(await late.ready).toBe(true)
  })

  it('routes file data and in-order control messages apart', async () => {
    const {a, b} = pair()
    const chunks: number[] = []
    const control: string[] = []
    const sender = new BulkChannel(asChannel(a), noop)
    new BulkChannel(asChannel(b), {
      onChunk: data => chunks.push(data.byteLength),
      onControl: raw => control.push(raw)
    })
    await vi.advanceTimersByTimeAsync(10)

    await sender.send(new Uint8Array(1000))
    await sender.send('{"t":"TRANSFER_COMPLETE"}')
    await vi.advanceTimersByTimeAsync(10)
    expect(chunks).toEqual([1000])
    expect(control).toEqual(['{"t":"TRANSFER_COMPLETE"}'])
  })

  it('refuses a send on a closed channel rather than pretending it went', async () => {
    // Trystero's own send resolved successfully here, with the message lost.
    const {a, b} = pair()
    const channel = new BulkChannel(asChannel(a), noop)
    new BulkChannel(asChannel(b), noop)
    await vi.advanceTimersByTimeAsync(10)
    a.close()
    await expect(channel.send(new Uint8Array(10))).rejects.toMatchObject({code: 'connection-lost'})
  })

  it('waits while the buffer is full and carries on once it drains', async () => {
    const {a, b} = pair()
    const channel = new BulkChannel(asChannel(a), noop)
    new BulkChannel(asChannel(b), noop)
    await vi.advanceTimersByTimeAsync(10)

    a.bufferedAmount = BULK_HIGH_WATER
    let sent = false
    const pending = channel.send(new Uint8Array(64 * 1024)).then(() => (sent = true))
    await vi.advanceTimersByTimeAsync(10)
    expect(sent).toBe(false)

    a.drain()
    await pending
    expect(sent).toBe(true)
  })

  it('fails a send that is waiting on a channel that then closes', async () => {
    const {a, b} = pair()
    const channel = new BulkChannel(asChannel(a), noop)
    new BulkChannel(asChannel(b), noop)
    await vi.advanceTimersByTimeAsync(10)

    a.bufferedAmount = BULK_HIGH_WATER
    const pending = channel.send(new Uint8Array(64 * 1024))
    const outcome = expect(pending).rejects.toMatchObject({code: 'connection-lost'})
    a.close()
    await outcome
  })
})
