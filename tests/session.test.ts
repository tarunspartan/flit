import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {LIMITS, TIMEOUTS} from '../src/lib/core/config.ts'
import {SessionManager, type TransportFactory} from '../src/lib/session/SessionManager.ts'
import {MemoryNetwork, MemoryTransport} from '../src/lib/transport/MemoryTransport.ts'

/**
 * Session lifecycle, peer roster and signaling health.
 *
 * None of this had a test surface until `Transport` got its second adapter:
 * `SessionManager` built its own `TrysteroTransport`, so exercising any of it
 * meant real WebRTC and live relays. It is also the most-changed file in the
 * repo, and every commit touching it is a reliability fix — revive logic,
 * signaling state checks, peer management. Those are the cases below.
 *
 * Timers are faked throughout: the delivery `MemoryTransport` schedules, the
 * 3s health poll, the 2min reconnect window and the 6h room lifetime are all
 * timer-driven, and driving them by hand is what makes a six-hour expiry a
 * millisecond test.
 */

/** `RoomManager.shareUrl()` reads `location`; the snapshot calls it every time. */
beforeAll(() => {
  Object.defineProperty(globalThis, 'location', {
    value: {origin: 'https://flit.test', pathname: '/'},
    configurable: true,
    writable: true
  })
})

function harness() {
  const network = new MemoryNetwork()
  const built: MemoryTransport[] = []
  const factory: TransportFactory = options => {
    const transport = new MemoryTransport(network, options)
    built.push(transport)
    return transport
  }
  return {network, built, factory, open: () => new SessionManager(factory)}
}

/** Lets queued deliveries land, awaiting the microtasks between them. */
const settle = () => vi.advanceTimersByTimeAsync(20)

const live: SessionManager[] = []
function track(session: SessionManager): SessionManager {
  live.push(session)
  return session
}

beforeEach(() => vi.useFakeTimers())

afterEach(async () => {
  await Promise.all(live.splice(0).map(session => session.dispose()))
  vi.useRealTimers()
})

describe('the transport comes from the seam', () => {
  it('builds one through the factory rather than constructing its own', async () => {
    const {built, open} = harness()
    const session = track(open())

    expect(await session.openRoom()).toBe(true)
    expect(built).toHaveLength(1)
    expect(session.snapshot().status).toBe('open')
  })

  it('passes the local-network-only preference down to it, straight away', async () => {
    const {built, open} = harness()
    const session = track(open())

    await session.openRoom()
    expect(built[0]!.localOnly).toBe(false)

    // Rebuilds the connection at once rather than waiting for the next one —
    // and keeps the room while doing it.
    const code = session.snapshot().code
    session.setLocalOnly(true)
    await settle()
    expect(built).toHaveLength(2)
    expect(built[1]!.localOnly).toBe(true)
    expect(session.snapshot().code).toBe(code)
  })

  it('reports a transport that will not start as a readable failure', async () => {
    const session = track(
      new SessionManager(() => {
        throw new Error('ICE failed: 701')
      })
    )

    expect(await session.openRoom()).toBe(false)

    const {status, error} = session.snapshot()
    expect(status).toBe('ended')
    expect(error?.code).toBe('connection-failed')
    // §26: never show the raw failure.
    expect(error?.message).not.toContain('701')
    expect(error?.title.length).toBeGreaterThan(0)
  })
})

describe('two devices in a room', () => {
  it('each end lists the other once both have joined', async () => {
    const {factory, open} = harness()
    const host = track(open())
    await host.openRoom()
    const code = host.snapshot().code
    expect(code).not.toBeNull()

    const guest = track(new SessionManager(factory))
    expect(await guest.joinRoom(code!)).toBe(true)
    await settle()

    expect(host.snapshot().peers).toHaveLength(1)
    expect(guest.snapshot().peers).toHaveLength(1)
    // The name arrives over HELLO rather than from the transport.
    expect(host.snapshot().peers[0]!.name.length).toBeGreaterThan(0)
  })

  it('classifies the link from what the transport reports', async () => {
    const {factory, built, open} = harness()
    const host = track(open())
    await host.openRoom()
    const guest = track(new SessionManager(factory))
    await guest.joinRoom(host.snapshot().code!)
    await settle()

    expect(host.snapshot().peers[0]!.path.kind).toBe('local')

    built[1]!.setPath({
      kind: 'relay',
      protocol: 'WebRTC DataChannel',
      network: 'Internet via relay',
      roundTripMs: 180
    })
    await settle()

    // A relay is the one reading that always wins, from either end.
    expect(host.snapshot().peers[0]!.path.kind).toBe('relay')
  })

  it('keeps a vanished device listed while it might still come back', async () => {
    const {factory, built, open} = harness()
    const host = track(open())
    await host.openRoom()
    const guest = track(new SessionManager(factory))
    await guest.joinRoom(host.snapshot().code!)
    await settle()

    // The tab-was-killed case: gone without a clean leave.
    built[1]!.vanish()
    await settle()

    const away = host.snapshot().peers
    expect(away).toHaveLength(1)
    expect(away[0]!.present).toBe(false)
    // A reconnect can land anywhere, so the old reading is not carried over.
    expect(away[0]!.path.kind).toBe('unknown')

    await vi.advanceTimersByTimeAsync(TIMEOUTS.reconnectWindowMs + 1000)
    expect(host.snapshot().peers).toHaveLength(0)
  })
})

describe('signaling health', () => {
  it('holds through a blip, then degrades, then recovers', async () => {
    const {network, open} = harness()
    const session = track(open())
    await session.openRoom()
    expect(session.snapshot().signaling).toBe('ok')

    network.signalingReady = false

    // Inside the grace window this is a blip, and saying so would be noise.
    await vi.advanceTimersByTimeAsync(6000)
    expect(session.snapshot().signaling).toBe('ok')

    await vi.advanceTimersByTimeAsync(12_000)
    expect(session.snapshot().signaling).toBe('retrying')

    await vi.advanceTimersByTimeAsync(25_000)
    expect(session.snapshot().signaling).toBe('offline')

    network.signalingReady = true
    await vi.advanceTimersByTimeAsync(4000)
    expect(session.snapshot().signaling).toBe('ok')
  })
})

describe('room lifetime', () => {
  it('ends the session when the code stops working', async () => {
    const {open} = harness()
    const session = track(open())
    await session.openRoom()
    expect(session.snapshot().status).toBe('open')

    await vi.advanceTimersByTimeAsync(LIMITS.roomLifetimeMs + 1000)

    const {status, error, code} = session.snapshot()
    expect(status).toBe('ended')
    expect(error?.code).toBe('room-expired')
    expect(code).toBeNull()
  })

  it('does not expire a room that is still inside its lifetime', async () => {
    const {open} = harness()
    const session = track(open())
    await session.openRoom()

    await vi.advanceTimersByTimeAsync(LIMITS.roomLifetimeMs - 60_000)
    expect(session.snapshot().status).toBe('open')
  })
})

/**
 * Two sessions whose transports keep their ids across a rebuild, as Trystero's
 * do for the life of a page. That is what lets a device that reconnects be
 * recognised as the same device rather than a stranger.
 */
function stablePair() {
  const network = new MemoryNetwork()
  const make = (selfId: string) =>
    track(new SessionManager(options => new MemoryTransport(network, {...options, selfId})))
  return {host: make('host'), guest: make('guest')}
}

async function connected() {
  const {host, guest} = stablePair()
  await host.openRoom()
  await guest.joinRoom(host.snapshot().code!)
  await settle()
  expect(host.snapshot().peers).toHaveLength(1)
  return {host, guest}
}

const file = (name: string, bytes = 10) => new File([new Uint8Array(bytes).fill(7)], name)

describe('sharing with the room', () => {
  it('offers every file from a large drop to the other device', async () => {
    // Offers went out all at once and the receiver's rate limiter dropped
    // everything past its burst of 400 — those files simply never appeared.
    const {host, guest} = await connected()
    host.shareFiles(Array.from({length: 450}, (_, i) => file(`f${i}.txt`)))
    await vi.advanceTimersByTimeAsync(8000)
    expect(guest.snapshot().incoming).toHaveLength(450)
  })

  it('keeps the screen awake only while bytes are moving', async () => {
    // A single offer nobody had accepted used to hold the wake lock on both
    // devices for the room's whole lifetime.
    const {host, guest} = await connected()
    host.shareFiles([file('a.txt')])
    await settle()

    expect(host.hasMovingTransfers()).toBe(false)
    expect(guest.hasMovingTransfers()).toBe(false)
    // Closing the sharing tab would un-share the file, so that one still asks.
    expect(host.hasUnfinishedWork()).toBe(true)
    // An offer *to* this device is not a reason to keep it open.
    expect(guest.hasUnfinishedWork()).toBe(false)
  })
})

describe('reconnecting by hand', () => {
  it('keeps everything this device shared, and the transfer still completes', async () => {
    // "Reconnect now" used to reset the transfers: the shared list emptied and
    // the other device was left with offers nobody would ever serve.
    vi.useRealTimers()
    const {host, guest} = stablePair()
    await host.openRoom()
    await guest.joinRoom(host.snapshot().code!)
    await waitUntil(() => host.snapshot().peers.length === 1)

    const bytes = 700 * 1024
    host.shareFiles([file('keep.bin', bytes)])
    await waitUntil(() => guest.snapshot().incoming.length === 1)

    expect(await host.reconnect()).toBe(true)
    expect(host.snapshot().shared).toHaveLength(1)
    await waitUntil(() => host.snapshot().peers[0]?.present === true)

    guest.accept(guest.snapshot().incoming[0]!.id)
    await waitUntil(
      () =>
        guest.snapshot().incoming[0]?.state === 'COMPLETED' &&
        host.snapshot().shared[0]?.transfers[0]?.state === 'COMPLETED'
    )
    expect(guest.snapshot().incoming[0]!.bytesTransferred).toBe(bytes)
  })
})

/** Polls in real time, for the tests that run a real transfer. */
async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
