import {afterEach, describe, expect, it, vi} from 'vitest'
import {formatCode, isValidCode, normalizeCode, randomCode, deriveRoomTopic} from '../src/lib/core/ids.ts'
import {ChunkTreeHasher} from '../src/lib/integrity/hash.ts'
import {decodeChunk, encodeChunk, FRAME_HEADER_BYTES} from '../src/lib/protocol/frame.ts'
import {MessageRateLimiter, parseControl} from '../src/lib/protocol/validate.ts'
import {PROTOCOL_VERSION} from '../src/lib/protocol/messages.ts'
import {canTransition, isTerminal} from '../src/lib/transfer/states.ts'
import {FlowController} from '../src/lib/transfer/FlowController.ts'
import {sanitizeFilename, sanitizeRelativePath, uniqueFilename} from '../src/lib/utils/filename.ts'
import {SpeedMeter} from '../src/lib/utils/speed.ts'
import {agreeKind, bandwidthCost, classifyPath, isPrivate, sameSubnet, steadyPath} from '../src/lib/transport/pathClassifier.ts'
import {formatBytes, formatDuration} from '../src/lib/utils/format.ts'
import {takeSharedFiles} from '../src/lib/utils/shareTarget.ts'

describe('pairing codes', () => {
  it('generates 12 symbols of Crockford base32', () => {
    for (let i = 0; i < 50; i++) {
      const code = randomCode()
      expect(code).toHaveLength(12)
      expect(isValidCode(code)).toBe(true)
      expect(code).not.toMatch(/[ILOU]/)
    }
  })

  it('formats in groups of four', () => {
    expect(formatCode('K7XM42QW9PZT')).toBe('K7XM-42QW-9PZT')
  })

  it('accepts what people actually type', () => {
    expect(normalizeCode('k7xm-42qw-9pzt')).toBe('K7XM42QW9PZT')
    expect(normalizeCode('k7xm 42qw 9pzt')).toBe('K7XM42QW9PZT')
    // Crockford folds the ambiguous letters onto digits.
    expect(normalizeCode('OIL')).toBe('011')
    expect(normalizeCode('U')).toBe('V')
  })

  it('rejects wrong lengths and stray symbols', () => {
    expect(isValidCode('SHORT')).toBe(false)
    expect(isValidCode('K7XM42QW9PZTX')).toBe(false)
  })

  it('derives an opaque topic that never contains the code', async () => {
    const code = 'K7XM42QW9PZT'
    const topic = await deriveRoomTopic('app', code)
    expect(topic).toMatch(/^[0-9a-f]{32}$/)
    expect(topic).not.toContain(code.toLowerCase())
    expect(await deriveRoomTopic('app', code)).toBe(topic)
    expect(await deriveRoomTopic('other-app', code)).not.toBe(topic)
  })
})

describe('filename sanitization', () => {
  it('strips path components so nothing escapes the destination', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('C:\\Windows\\System32\\evil.dll')).toBe('evil.dll')
    expect(sanitizeFilename('/absolute/path/file.txt')).toBe('file.txt')
  })

  it('removes control characters and bidi overrides', () => {
    expect(sanitizeFilename('bad\u0000name.txt')).toBe('bad_name.txt')
    expect(sanitizeFilename('invoice\u202egpj.exe')).toBe('invoicegpj.exe')
  })

  it('handles hidden, reserved, empty and non-string names', () => {
    expect(sanitizeFilename('.hidden')).toBe('hidden')
    expect(sanitizeFilename('CON')).toBe('file')
    expect(sanitizeFilename('nul.txt')).toBe('file')
    expect(sanitizeFilename('')).toBe('file')
    expect(sanitizeFilename(null)).toBe('file')
    expect(sanitizeFilename('trailing. ')).toBe('trailing')
  })

  it('keeps unicode names intact', () => {
    expect(sanitizeFilename('résumé — 2026.pdf')).toBe('résumé — 2026.pdf')
    expect(sanitizeFilename('写真.jpg')).toBe('写真.jpg')
  })

  it('truncates on bytes while preserving the extension', () => {
    const long = `${'ä'.repeat(400)}.jpg`
    const result = sanitizeFilename(long)
    expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(255)
    expect(result.endsWith('.jpg')).toBe(true)
  })

  it('de-duplicates instead of overwriting', () => {
    const taken = new Set(['a.txt'])
    expect(uniqueFilename('a.txt', taken)).toBe('a (2).txt')
    expect(uniqueFilename('b.txt', taken)).toBe('b.txt')
  })

  it('constrains folder paths to their destination', () => {
    expect(sanitizeRelativePath('project/src/index.ts')).toEqual(['project', 'src', 'index.ts'])
    expect(sanitizeRelativePath('../../../etc/passwd')).toEqual(['etc', 'passwd'])
    expect(sanitizeRelativePath('/a/./b')).toEqual(['a', 'b'])
    expect(sanitizeRelativePath(42)).toEqual([])
  })
})

describe('chunk framing', () => {
  it('round-trips a frame', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5])
    const frame = decodeChunk(encodeChunk(9, 1234, payload), 1024)
    expect(frame).not.toBeNull()
    expect(frame?.seq).toBe(9)
    expect(frame?.index).toBe(1234)
    expect([...(frame?.payload ?? [])]).toEqual([1, 2, 3, 4, 5])
  })

  it('rejects malformed input rather than guessing', () => {
    expect(decodeChunk('not a frame', 1024)).toBeNull()
    expect(decodeChunk(new Uint8Array(4), 1024)).toBeNull()
    expect(decodeChunk(null, 1024)).toBeNull()
  })

  it('rejects a declared length that does not match the bytes received', () => {
    const frame = encodeChunk(1, 0, new Uint8Array(64))
    expect(decodeChunk(frame.subarray(0, FRAME_HEADER_BYTES + 32), 1024)).toBeNull()
  })

  it('rejects payloads larger than the negotiated chunk size', () => {
    const frame = encodeChunk(1, 0, new Uint8Array(2048))
    expect(decodeChunk(frame, 1024)).toBeNull()
  })
})

describe('protocol validation', () => {
  const offer = {
    v: PROTOCOL_VERSION,
    t: 'TRANSFER_OFFER',
    transferId: 'abc123',
    seq: 1,
    name: 'a.txt',
    size: 1024,
    mimeType: 'text/plain',
    lastModified: 1,
    chunkSize: 4096,
    totalChunks: 1,
    hashAlgorithm: 'sha256-chunktree-v1'
  }

  it('accepts a well-formed message', () => {
    const result = parseControl(offer)
    expect(result.ok).toBe(true)
  })

  it('rejects a chunk count that contradicts the size', () => {
    expect(parseControl({...offer, totalChunks: 99}).ok).toBe(false)
  })

  it('rejects unknown types, bad ids and missing fields', () => {
    expect(parseControl({...offer, t: 'EVIL'}).ok).toBe(false)
    expect(parseControl({...offer, transferId: '../../x'}).ok).toBe(false)
    expect(parseControl({...offer, size: -1}).ok).toBe(false)
    expect(parseControl({...offer, size: 1.5}).ok).toBe(false)
    expect(parseControl({v: PROTOCOL_VERSION}).ok).toBe(false)
    expect(parseControl(null).ok).toBe(false)
    expect(parseControl([]).ok).toBe(false)
  })

  it('flags an incompatible protocol version distinctly', () => {
    const result = parseControl({...offer, v: PROTOCOL_VERSION + 1})
    expect(result).toEqual({ok: false, reason: 'incompatible-version'})
  })

  it('rejects oversized control payloads', () => {
    const huge = JSON.stringify({...offer, name: 'x'.repeat(200_000)})
    expect(parseControl(huge)).toEqual({ok: false, reason: 'too-large'})
  })

  it('rate limits a flooding peer', () => {
    const limiter = new MessageRateLimiter(10)
    let allowed = 0
    for (let i = 0; i < 100; i++) if (limiter.allow(1000)) allowed++
    expect(allowed).toBeLessThan(100)
    expect(allowed).toBeGreaterThan(0)
  })
})

describe('chunk tree hashing', () => {
  const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill)

  it('is deterministic and order-independent', async () => {
    const a = new ChunkTreeHasher(300, 100, 3)
    const b = new ChunkTreeHasher(300, 100, 3)
    await a.add(0, bytes(100, 1))
    await a.add(1, bytes(100, 2))
    await a.add(2, bytes(100, 3))
    // Same chunks, arriving in a different order.
    await b.add(2, bytes(100, 3))
    await b.add(0, bytes(100, 1))
    await b.add(1, bytes(100, 2))
    expect(await a.root()).toBe(await b.root())
  })

  it('detects a single flipped byte', async () => {
    const a = new ChunkTreeHasher(200, 100, 2)
    const b = new ChunkTreeHasher(200, 100, 2)
    await a.add(0, bytes(100, 1))
    await a.add(1, bytes(100, 2))
    await b.add(0, bytes(100, 1))
    const tampered = bytes(100, 2)
    tampered[50] = 99
    await b.add(1, tampered)
    expect(await a.root()).not.toBe(await b.root())
  })

  it('binds the file structure into the hash', async () => {
    const a = new ChunkTreeHasher(200, 100, 2)
    const b = new ChunkTreeHasher(999, 100, 2)
    await a.add(0, bytes(100, 1))
    await a.add(1, bytes(100, 1))
    await b.add(0, bytes(100, 1))
    await b.add(1, bytes(100, 1))
    expect(await a.root()).not.toBe(await b.root())
  })

  it('refuses to hash an incomplete file', async () => {
    const hasher = new ChunkTreeHasher(200, 100, 2)
    await hasher.add(0, bytes(100, 1))
    expect(hasher.complete).toBe(false)
    await expect(hasher.root()).rejects.toThrow()
  })

  it('tracks contiguous progress across gaps', async () => {
    const hasher = new ChunkTreeHasher(500, 100, 5)
    await hasher.add(0, bytes(100, 0))
    await hasher.add(1, bytes(100, 0))
    await hasher.add(3, bytes(100, 0))
    expect(hasher.contiguousCount()).toBe(2)
    await hasher.add(2, bytes(100, 0))
    expect(hasher.contiguousCount()).toBe(4)
  })

  it('drops digests above a resume point', async () => {
    const hasher = new ChunkTreeHasher(300, 100, 3)
    await hasher.add(0, bytes(100, 1))
    await hasher.add(1, bytes(100, 2))
    hasher.truncateTo(1)
    expect(hasher.has(0)).toBe(true)
    expect(hasher.has(1)).toBe(false)
    expect(hasher.contiguousCount()).toBe(1)
  })

  it('handles an empty file', async () => {
    const hasher = new ChunkTreeHasher(0, 100, 0)
    expect(hasher.complete).toBe(true)
    expect(await hasher.root()).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('transfer state machine', () => {
  it('allows the documented edges', () => {
    expect(canTransition('QUEUED', 'WAITING_FOR_ACCEPT')).toBe(true)
    expect(canTransition('WAITING_FOR_ACCEPT', 'TRANSFERRING')).toBe(true)
    expect(canTransition('TRANSFERRING', 'PAUSED')).toBe(true)
    expect(canTransition('TRANSFERRING', 'RECONNECTING')).toBe(true)
    expect(canTransition('RECONNECTING', 'TRANSFERRING')).toBe(true)
    expect(canTransition('VERIFYING', 'COMPLETED')).toBe(true)
  })

  it('forbids skipping verification and leaving terminal states', () => {
    expect(canTransition('TRANSFERRING', 'COMPLETED')).toBe(false)
    expect(canTransition('COMPLETED', 'TRANSFERRING')).toBe(false)
    expect(canTransition('FAILED', 'TRANSFERRING')).toBe(false)
    expect(canTransition('QUEUED', 'TRANSFERRING')).toBe(false)
  })

  it('knows which states are terminal', () => {
    expect(isTerminal('COMPLETED')).toBe(true)
    expect(isTerminal('CANCELLED')).toBe(true)
    expect(isTerminal('TRANSFERRING')).toBe(false)
  })
})

describe('flow control', () => {
  it('bounds concurrent sends and releases waiters in order', async () => {
    const flow = new FlowController(2)
    await flow.acquire()
    await flow.acquire()
    expect(flow.inFlight).toBe(2)

    let third = false
    const pending = flow.acquire().then(() => {
      third = true
    })
    await Promise.resolve()
    expect(third).toBe(false)

    flow.release()
    await pending
    expect(third).toBe(true)
    expect(flow.inFlight).toBe(2)
  })
})

describe('speed and ETA', () => {
  it('stays quiet until it has enough data', () => {
    const meter = new SpeedMeter()
    expect(meter.rate(0)).toBeNull()
    meter.record(1000, 0)
    expect(meter.rate(100)).toBeNull()
  })

  it('averages over the window', () => {
    const meter = new SpeedMeter()
    for (let i = 0; i <= 10; i++) meter.record(1_000_000, i * 100)
    const rate = meter.rate(1000)
    expect(rate).not.toBeNull()
    // 10 MB across 1 s after discarding the window's first sample.
    expect(rate!).toBeGreaterThan(9_000_000)
    expect(rate!).toBeLessThan(11_000_000)
  })

  it('produces an ETA and resets cleanly', () => {
    const meter = new SpeedMeter()
    for (let i = 0; i <= 10; i++) meter.record(1_000_000, i * 100)
    expect(meter.eta(10_000_000, 1000)).toBeCloseTo(1, 0)
    expect(meter.eta(0, 1000)).toBe(0)
    meter.reset()
    expect(meter.rate(1000)).toBeNull()
  })
})

describe('network path classification', () => {
  it('recognises private and link-local addresses', () => {
    expect(isPrivate('192.168.1.5')).toBe(true)
    expect(isPrivate('10.0.0.1')).toBe(true)
    expect(isPrivate('172.16.4.4')).toBe(true)
    expect(isPrivate('172.32.4.4')).toBe(false)
    expect(isPrivate('169.254.1.1')).toBe(true)
    // Chrome hides host candidates behind mDNS names.
    expect(isPrivate('a1b2c3d4-0000-0000-0000-000000000000.local')).toBe(true)
    expect(isPrivate('fe80::1')).toBe(true)
    expect(isPrivate('fd12::1')).toBe(true)
  })

  it('recognises two devices on the same link', () => {
    // The case that made every connection read as "Internet": home networks
    // hand out globally-routable IPv6, so same-Wi-Fi peers pair public-looking
    // addresses that never actually leave the router.
    expect(sameSubnet('2401:4900:1c80:5b2::a1', '2401:4900:1c80:5b2::7f')).toBe(true)
    expect(sameSubnet('2401:4900:1c80:5b2:1::1', '2401:4900:1c80:5b3:1::1')).toBe(false)
    expect(isPrivate('2401:4900:1c80:5b2::a1')).toBe(false)

    expect(sameSubnet('192.168.1.10', '192.168.1.44')).toBe(true)
    expect(sameSubnet('192.168.1.10', '192.168.2.44')).toBe(false)
    expect(sameSubnet('93.184.216.34', '104.18.32.7')).toBe(false)
    expect(sameSubnet('', '')).toBe(false)
  })

  it('treats public addresses as non-local', () => {
    expect(isPrivate('93.184.216.34')).toBe(false)
    expect(isPrivate('2606:2800:220:1::1')).toBe(false)
    expect(isPrivate('')).toBe(false)
  })
})

/** A minimal stats report: RTCStatsReport is a Map as far as this code cares. */
function fakePeer(
  local: Record<string, unknown>,
  remote: Record<string, unknown>
): RTCPeerConnection {
  const stats = new Map<string, Record<string, unknown>>([
    ['L', {type: 'local-candidate', id: 'L', ...local}],
    ['R', {type: 'remote-candidate', id: 'R', ...remote}],
    [
      'P',
      {
        type: 'candidate-pair',
        id: 'P',
        state: 'succeeded',
        nominated: true,
        localCandidateId: 'L',
        remoteCandidateId: 'R',
        currentRoundTripTime: 0.004
      }
    ],
    ['T', {type: 'transport', id: 'T', selectedCandidatePairId: 'P'}]
  ])
  return {getStats: async () => stats} as unknown as RTCPeerConnection
}

describe('both ends of one link agree on what it is', () => {
  // A Mac and an Android on one Wi-Fi, reported as "Local network" on the Mac
  // and "Internet" on the phone. Same connection, two views of it: the phone
  // never resolved the Mac's mDNS name, so it learned the address from the
  // arriving STUN check and recorded it peer-reflexive instead of host.
  const MAC = '192.168.1.20'
  const PHONE = '192.168.1.31'

  it('reads the same LAN link as local from either end', async () => {
    const fromMac = await classifyPath(
      fakePeer({candidateType: 'host', address: MAC}, {candidateType: 'host', address: PHONE})
    )
    const fromPhone = await classifyPath(
      fakePeer({candidateType: 'host', address: PHONE}, {candidateType: 'prflx', address: MAC})
    )

    expect(fromMac.kind).toBe('local')
    expect(fromPhone.kind).toBe('local')
    expect(fromPhone.network).toBe(fromMac.network)
    expect(fromMac.roundTripMs).toBe(4)
  })

  it('still calls a peer-reflexive candidate on a public address the internet', () => {
    // prflx is not by itself evidence of locality — the address decides.
    return classifyPath(
      fakePeer(
        {candidateType: 'host', address: PHONE},
        {candidateType: 'prflx', address: '203.0.113.9'}
      )
    ).then(path => expect(path.kind).toBe('direct'))
  })

  it('does not guess local when mDNS hides one side and the other is public', async () => {
    const path = await classifyPath(
      fakePeer({candidateType: 'host', address: ''}, {candidateType: 'prflx', address: '203.0.113.9'})
    )
    expect(path.kind).toBe('direct')
  })

  it('keeps NAT traversal and relaying distinct from local', async () => {
    const nat = await classifyPath(
      fakePeer(
        {candidateType: 'srflx', address: '203.0.113.9'},
        {candidateType: 'srflx', address: '198.51.100.7'}
      )
    )
    expect(nat.kind).toBe('direct')

    const relayed = await classifyPath(
      fakePeer({candidateType: 'relay', address: '203.0.113.9'}, {candidateType: 'host', address: PHONE})
    )
    expect(relayed.kind).toBe('relay')
  })

  it('lets the end that found evidence settle the disagreement', () => {
    // 'direct' means "could not prove local", never "proved remote", so the
    // side holding evidence wins. Relay outranks everything: those bytes really
    // are going through a server.
    expect(agreeKind('direct', 'local')).toBe('local')
    expect(agreeKind('local', 'direct')).toBe('local')
    expect(agreeKind('relay', 'local')).toBe('relay')
    expect(agreeKind('direct', 'relay')).toBe('relay')

    expect(agreeKind('unknown', 'direct')).toBe('direct')
    expect(agreeKind('unknown', 'local')).toBe('local')
    expect(agreeKind('unknown', 'unknown')).toBe('unknown')
    expect(agreeKind('direct', 'direct')).toBe('direct')
    expect(agreeKind('local', 'local')).toBe('local')
  })

  it('does not let a later poll unprove a link it already proved local', async () => {
    // ICE renominates after connecting, and the new pair's remote half is often
    // server-reflexive — the classifier then says 'direct' about two devices
    // that never moved. That is what made a same-Wi-Fi badge flip to "Internet"
    // seconds after showing "Local network".
    const local = await classifyPath(
      fakePeer(
        {candidateType: 'host', address: '192.168.1.20'},
        {candidateType: 'host', address: '192.168.1.31'}
      )
    )
    const renominated = await classifyPath(
      fakePeer(
        {candidateType: 'host', address: '192.168.1.20'},
        {candidateType: 'srflx', address: '203.0.113.9'}
      )
    )
    expect(renominated.kind).toBe('direct')
    expect(steadyPath(local, renominated).kind).toBe('local')
    // RTT is still whatever the latest poll measured.
    expect(steadyPath(local, renominated).roundTripMs).toBe(renominated.roundTripMs)
  })

  it('still reports a relay, and still starts from nothing', async () => {
    const local = await classifyPath(
      fakePeer(
        {candidateType: 'host', address: '192.168.1.20'},
        {candidateType: 'host', address: '192.168.1.31'}
      )
    )
    const relayed = await classifyPath(
      fakePeer({candidateType: 'relay', address: '203.0.113.9'}, {candidateType: 'host', address: '192.168.1.31'})
    )
    // Relay is positive evidence, so it overrides a proven local.
    expect(steadyPath(local, relayed).kind).toBe('relay')
    // A poll with no selected pair says nothing and must not downgrade either.
    const nothing = {...local, kind: 'unknown' as const}
    expect(steadyPath(local, nothing).kind).toBe('local')
    // With no history there is nothing to hold on to.
    expect(steadyPath(undefined, relayed).kind).toBe('relay')
    // 'direct' is not sticky the way 'local' is: it was never proof of anything.
    const direct = {...local, kind: 'direct' as const}
    expect(steadyPath(direct, local).kind).toBe('local')
  })

  it('is symmetric, so neither device can be the one that is wrong', () => {
    const kinds = ['local', 'direct', 'relay', 'unknown'] as const
    for (const mine of kinds) {
      for (const theirs of kinds) {
        expect(agreeKind(mine, theirs)).toBe(agreeKind(theirs, mine))
      }
    }
  })
})

describe('files arriving from the OS share sheet', () => {
  /** Stands in for the cache the service worker parks a share in. */
  function stubCaches(entries: {url: string; body: string; name: string; type: string}[]) {
    const store = entries.map(entry => ({
      request: {url: entry.url},
      response: new Response(entry.body, {
        headers: {
          'content-type': entry.type,
          'x-share-name': encodeURIComponent(entry.name),
          'x-share-modified': '1700000000000'
        }
      })
    }))

    let deleted = false
    const cache = {
      keys: async () => store.map(item => item.request),
      match: async (key: {url: string}) =>
        store.find(item => item.request.url === key.url)?.response
    }

    globalThis.caches = {
      open: async () => cache,
      delete: async () => {
        deleted = true
        return true
      }
    } as unknown as CacheStorage

    return () => deleted
  }

  afterEach(() => {
    delete (globalThis as {caches?: unknown}).caches
  })

  it('returns the files in the order they were shared', async () => {
    // cache.keys() has no meaningful order, so the key carries the index.
    stubCaches([
      {url: 'https://x/flit/shared-file/2', body: 'third', name: 'c.txt', type: 'text/plain'},
      {url: 'https://x/flit/shared-file/0', body: 'first', name: 'a.txt', type: 'text/plain'},
      {url: 'https://x/flit/shared-file/1', body: 'second', name: 'b.txt', type: 'text/plain'}
    ])

    const files = await takeSharedFiles()
    expect(files.map(file => file.name)).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(await files[0]?.text()).toBe('first')
    expect(files[0]?.lastModified).toBe(1700000000000)
  })

  it('carries names that would not survive a raw header', async () => {
    stubCaches([
      {
        url: 'https://x/flit/shared-file/0',
        body: 'x',
        name: 'Ärende — photo (1).jpg',
        type: 'image/jpeg'
      }
    ])

    const files = await takeSharedFiles()
    expect(files[0]?.name).toBe('Ärende — photo (1).jpg')
    expect(files[0]?.type).toBe('image/jpeg')
  })

  it('never leaves shared copies sitting in storage', async () => {
    const wasDeleted = stubCaches([
      {url: 'https://x/flit/shared-file/0', body: 'x', name: 'a.txt', type: 'text/plain'}
    ])

    await takeSharedFiles()
    expect(wasDeleted()).toBe(true)
  })

  it('reports nothing when the browser has no cache storage at all', async () => {
    delete (globalThis as {caches?: unknown}).caches
    expect(await takeSharedFiles()).toEqual([])
  })
})

describe('formatting', () => {
  it('formats byte sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1024)).toBe('1.00 KB')
    expect(formatBytes(1.8 * 1024 ** 3)).toBe('1.80 GB')
  })

  it('avoids misleading countdowns', () => {
    expect(formatDuration(null)).toBe('Calculating…')
    expect(formatDuration(0.4)).toBe('less than a second')
    expect(formatDuration(90)).toBe('1 min 30 sec')
    expect(formatDuration(7200)).toBe('2 hr')
  })
})

describe('persistent storage', () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

  const withNavigator = (value: unknown) => {
    Object.defineProperty(globalThis, 'navigator', {value, configurable: true, writable: true})
  }

  afterEach(() => {
    if (real) Object.defineProperty(globalThis, 'navigator', real)
    vi.resetModules()
  })

  /** A fresh copy, because the module memoizes the answer for the whole page. */
  const freshModule = async () => {
    vi.resetModules()
    return import('../src/lib/storage/estimate.ts')
  }

  it('reports false where the API does not exist, without throwing', async () => {
    withNavigator({})
    const {requestPersistentStorage} = await freshModule()
    await expect(requestPersistentStorage()).resolves.toBe(false)
  })

  it('survives navigator being absent entirely, as in a worker', async () => {
    // Referencing an undeclared global throws rather than yielding undefined,
    // so this is not the same case as the one above.
    // @ts-expect-error deleting a global for the duration of the test
    delete globalThis.navigator
    const {requestPersistentStorage} = await freshModule()
    await expect(requestPersistentStorage()).resolves.toBe(false)
  })

  it('asks the browser at most once per page', async () => {
    const persist = vi.fn().mockResolvedValue(true)
    withNavigator({storage: {persist, persisted: vi.fn().mockResolvedValue(false)}})
    const {requestPersistentStorage} = await freshModule()

    const answers = await Promise.all([
      requestPersistentStorage(),
      requestPersistentStorage(),
      requestPersistentStorage()
    ])
    expect(answers).toEqual([true, true, true])
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('does not ask again once the origin is already persisted', async () => {
    const persist = vi.fn()
    withNavigator({storage: {persist, persisted: vi.fn().mockResolvedValue(true)}})
    const {requestPersistentStorage} = await freshModule()

    await expect(requestPersistentStorage()).resolves.toBe(true)
    expect(persist).not.toHaveBeenCalled()
  })

  it('treats a refusal as a refusal rather than an error', async () => {
    withNavigator({
      storage: {persist: vi.fn().mockRejectedValue(new Error('denied')), persisted: vi.fn().mockResolvedValue(false)}
    })
    const {requestPersistentStorage} = await freshModule()
    await expect(requestPersistentStorage()).resolves.toBe(false)
  })
})

describe('bandwidth cost of a path', () => {
  it('calls only a proven local link free', () => {
    expect(bandwidthCost('local')).toBe('local')
  })

  it('treats direct as internet — direct never means nearby', () => {
    // 'direct' is what the classifier reports when locality could not be shown,
    // not a claim that the peer is remote *or* local. It can be a peer on the
    // other side of the world, so it must not read as free.
    expect(bandwidthCost('direct')).toBe('internet')
  })

  it('treats relay as internet, not as its own category', () => {
    // Relayed bytes cost the same connection, and more of it. Whether a server
    // is in the middle is a trust question, answered elsewhere.
    expect(bandwidthCost('relay')).toBe('internet')
  })

  it('says nothing at all while the path is unknown', () => {
    expect(bandwidthCost('unknown')).toBeNull()
  })
})
