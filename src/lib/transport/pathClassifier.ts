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

  return {
    kind,
    protocol: PROTOCOL,
    network: kind === 'local' ? localLabel() : NETWORK_LABEL[kind],
    roundTripMs: rtt
  }
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

function classify(local?: CandidateStat, remote?: CandidateStat): PathKind {
  if (!local || !remote) return 'unknown'

  // A relay on either end means the bytes pass through a TURN server.
  if (local.candidateType === 'relay' || remote.candidateType === 'relay') return 'relay'

  const localHost = local.candidateType === 'host'
  const remoteHost = remote.candidateType === 'host'

  // Host-to-host means ICE needed no NAT traversal at all, which in practice
  // means the two devices can reach each other directly on the same network.
  //
  // Checking for a *private* address is not enough: home networks hand out
  // globally-routable IPv6, so two devices on the same Wi-Fi commonly pair
  // public-looking addresses that never leave the router. Same-link evidence
  // (matching subnet) counts as local too.
  if (localHost && remoteHost) {
    const a = addressOf(local)
    const b = addressOf(remote)
    if (isPrivate(a) && isPrivate(b)) return 'local'
    if (sameSubnet(a, b)) return 'local'
    // mDNS hides the address entirely; host-to-host is still the local case.
    if (a === '' || b === '') return 'local'
  }

  return 'direct'
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

/**
 * The Network Information API can confirm Wi-Fi on some platforms. Where it
 * cannot, we say "Local network" rather than claiming a link type we don't know.
 */
function localLabel(): string {
  const connection = (navigator as unknown as {connection?: {type?: string}}).connection
  if (connection?.type === 'wifi') return 'Local Wi-Fi'
  if (connection?.type === 'ethernet') return 'Local Ethernet'
  return 'Local network'
}
