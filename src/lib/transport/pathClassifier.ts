import type {NetworkPath, PathKind} from './Transport.ts'

/**
 * Classifies the live connection from the *actual* selected ICE candidate pair
 * (spec §59) rather than assuming "both on Wi-Fi ⇒ local", which is not
 * reliable.
 */

const PROTOCOL = 'WebRTC DataChannel'

const NETWORK_LABEL: Record<PathKind, string> = {
  local: 'Local network',
  direct: 'Internet',
  relay: 'Internet via relay',
  unknown: 'Connecting…'
}

interface CandidateStat {
  candidateType?: string
  address?: string
  ip?: string
  protocol?: string
  relayProtocol?: string
}

export async function classifyPath(pc: RTCPeerConnection): Promise<NetworkPath> {
  let stats: RTCStatsReport
  try {
    stats = await pc.getStats()
  } catch {
    return {kind: 'unknown', protocol: PROTOCOL, network: NETWORK_LABEL.unknown, roundTripMs: null}
  }

  const pair = selectedPair(stats)
  if (!pair) {
    return {kind: 'unknown', protocol: PROTOCOL, network: NETWORK_LABEL.unknown, roundTripMs: null}
  }

  const local = stats.get(pair.localCandidateId) as CandidateStat | undefined
  const remote = stats.get(pair.remoteCandidateId) as CandidateStat | undefined
  const kind = classify(local, remote)
  const rtt = typeof pair.currentRoundTripTime === 'number' ? pair.currentRoundTripTime * 1000 : null

  return {kind, protocol: PROTOCOL, network: NETWORK_LABEL[kind], roundTripMs: rtt}
}

interface PairStat {
  localCandidateId: string
  remoteCandidateId: string
  currentRoundTripTime?: number
}

function selectedPair(stats: RTCStatsReport): PairStat | null {
  const all: Record<string, unknown>[] = []
  stats.forEach(report => all.push(report as Record<string, unknown>))

  const transport = all.find(
    stat => stat.type === 'transport' && typeof stat.selectedCandidatePairId === 'string'
  )
  if (transport) {
    const direct = stats.get(transport.selectedCandidatePairId as string)
    if (direct) return direct as unknown as PairStat
  }

  const succeeded = all.filter(stat => stat.type === 'candidate-pair' && stat.state === 'succeeded')
  // Firefox exposes `selected` on the pair instead of on the transport.
  const chosen = succeeded.find(pair => pair.nominated === true || pair.selected === true) ?? succeeded[0]
  return (chosen as unknown as PairStat) ?? null
}

/**
 * A candidate that names a real endpoint rather than a NAT mapping.
 *
 * `prflx` (peer-reflexive) belongs here with `host`. A peer-reflexive candidate
 * *is* a host candidate — one learned from an arriving STUN check instead of
 * from signaling, which happens routinely when the check outruns the candidate,
 * and every time the far side's mDNS `.local` name fails to resolve. Android
 * resolves those far less reliably than macOS does, so the same LAN link is
 * seen as (host, host) on one device and (host, prflx) on the other. Treating
 * `prflx` as NAT traversal is what made two ends of one connection disagree.
 */
function isDirectlyAddressed(candidate: CandidateStat): boolean {
  return candidate.candidateType === 'host' || candidate.candidateType === 'prflx'
}

function classify(local?: CandidateStat, remote?: CandidateStat): PathKind {
  if (!local || !remote) return 'unknown'

  // A relay on either end means the bytes pass through a TURN server.
  if (local.candidateType === 'relay' || remote.candidateType === 'relay') return 'relay'

  // A server-reflexive candidate is a NAT mapping discovered via STUN, so it is
  // real evidence of traversal and stays 'direct' — and both ends see it as
  // srflx, so they agree without help.
  if (!isDirectlyAddressed(local) || !isDirectlyAddressed(remote)) return 'direct'

  // Both ends are directly addressed, which in practice means the two devices
  // reach each other without NAT. Confirm with the addresses.
  //
  // Checking for a *private* address is not enough: home networks hand out
  // globally-routable IPv6, so two devices on the same Wi-Fi commonly pair
  // public-looking addresses that never leave the router. Same-link evidence
  // (matching subnet) counts as local too.
  const a = addressOf(local)
  const b = addressOf(remote)
  if (isPrivate(a) && isPrivate(b)) return 'local'
  if (sameSubnet(a, b)) return 'local'

  // mDNS hides an address entirely. Trust the end still readable rather than
  // assuming: a redacted address paired with a public one proves nothing.
  if (a === '' && (b === '' || isPrivate(b))) return 'local'
  if (b === '' && isPrivate(a)) return 'local'

  return 'direct'
}

/**
 * Reconciles the two ends' verdicts so one connection gets one label.
 *
 * 'local' and 'relay' are positive findings — a device says them only with
 * address or TURN evidence in hand. 'direct' is the fallback for when locality
 * could not be *proven*, never proof of the opposite. So a side that found
 * evidence outranks a side that did not, and the classifier's blind spots stop
 * being visible as two devices contradicting each other.
 */
export function agreeKind(mine: PathKind, theirs: PathKind): PathKind {
  if (mine === 'relay' || theirs === 'relay') return 'relay'
  if (mine === 'local' || theirs === 'local') return 'local'
  if (mine === 'direct' || theirs === 'direct') return 'direct'
  return 'unknown'
}

/**
 * Holds a proven verdict against a later reading that merely fails to reprove it.
 *
 * ICE keeps checking after a call connects and renominates the candidate pair
 * when a better one appears. A pair that was (host, prflx) on private addresses
 * can become one whose remote half is server-reflexive, and the classifier then
 * honestly reports 'direct' — so a same-Wi-Fi link read "Local network" and
 * flipped to "Internet" a few seconds later, with nothing about the two devices
 * having changed.
 *
 * The same rule as agreeKind, applied over time instead of across peers: 'local'
 * comes from address evidence, 'direct' is what gets reported when locality
 * could not be shown this time. Two devices do not stop sharing a network
 * because ICE picked a different pair. 'relay' is positive evidence of its own
 * and always wins, and the cache is dropped when a peer leaves, so a device that
 * genuinely moves networks is judged afresh on its next connection.
 */
export function steadyPath(previous: NetworkPath | undefined, fresh: NetworkPath): NetworkPath {
  if (!previous) return fresh
  if (fresh.kind === 'relay') return fresh
  // No selected pair this round says nothing at all about the link.
  if (fresh.kind === 'unknown') return {...previous, roundTripMs: fresh.roundTripMs}
  if (previous.kind === 'local' && fresh.kind === 'direct') {
    return {...previous, roundTripMs: fresh.roundTripMs}
  }
  return fresh
}

/** Applies an agreed kind to a locally-measured path, keeping our own RTT. */
export function withKind(path: NetworkPath, kind: PathKind): NetworkPath {
  return kind === path.kind ? path : {...path, kind, network: NETWORK_LABEL[kind]}
}

/**
 * Same-link heuristic: an IPv6 /64 (the standard link prefix) or an IPv4 /24.
 * Not exact — a /23 LAN would read as two networks — but it errs toward the
 * honest answer rather than claiming local when it cannot tell.
 */
export function sameSubnet(a: string, b: string): boolean {
  if (a === '' || b === '' || a === b) return a !== '' && a === b

  if (a.includes(':') && b.includes(':')) {
    const prefix = (address: string) => expandIpv6(address).slice(0, 4).join(':')
    return prefix(a) === prefix(b)
  }

  const v4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/
  const left = v4.exec(a)
  const right = v4.exec(b)
  return left !== null && right !== null && left[1] === right[1]
}

/** Expands `2001:db8::1` into its eight hextets so prefixes can be compared. */
function expandIpv6(address: string): string[] {
  const [head = '', tail = ''] = address.split('::')
  const left = head === '' ? [] : head.split(':')
  const right = tail === '' ? [] : tail.split(':')
  const missing = 8 - left.length - right.length
  const middle = address.includes('::') ? Array<string>(Math.max(0, missing)).fill('0') : []
  return [...left, ...middle, ...right].map(part => part.padStart(4, '0')).slice(0, 8)
}

function addressOf(candidate: CandidateStat): string {
  return (candidate.address ?? candidate.ip ?? '').toLowerCase()
}

/**
 * True for RFC1918 / link-local / unique-local addresses, and for the mDNS
 * `.local` hostnames Chrome substitutes for host candidates.
 */
export function isPrivate(address: string): boolean {
  if (address === '') return false
  if (address.endsWith('.local')) return true
  if (address === '::1' || address === '127.0.0.1') return true

  const v4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a === 10 || a === 127) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true
    return false
  }

  // IPv6: fc00::/7 (unique local) and fe80::/10 (link local).
  if (/^f[cd][0-9a-f]{2}:/.test(address)) return true
  if (/^fe[89ab][0-9a-f]:/.test(address)) return true
  return false
}

/*
 * There was a `localLabel()` here that read navigator.connection to say "Local
 * Wi-Fi" or "Local Ethernet". It is gone on purpose: only Chromium populates
 * that API, and one end of a link can be on Wi-Fi while the other is on
 * Ethernet, so it produced two different labels for one connection — the very
 * thing agreeKind exists to prevent. "Local network" is the only phrasing both
 * devices can truthfully show.
 */
