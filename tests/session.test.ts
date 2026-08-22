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
  for (const session of live.splice(0)) await session.endSession()
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

  it('passes the local-network-only preference down to it', async () => {
    const {built, open} = harness()
    const session = track(open())

    await session.openRoom()
    expect(built[0]!.localOnly).toBe(false)

    // Documented as taking effect on the next connection, not this one.
    session.setLocalOnly(true)
    expect(built[0]!.localOnly).toBe(false)

    await session.openRoom()
    expect(built[1]!.localOnly).toBe(true)
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
