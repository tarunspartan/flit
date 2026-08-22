import type {SessionSnapshot} from '../../lib/session/SessionManager.ts'
import type {PathKind} from '../../lib/transport/Transport.ts'

/**
 * The route: this device, the ones it is connected to, and the line to each.
 *
 * The path a file takes is this product's trust signal (spec §52–§65) and it
 * used to live as a small badge inside a popover nobody opens. Here it is the
 * first thing on the screen, drawn rather than described, with the line's own
 * texture carrying the classification:
 *
 *   solid          on your own network, nothing in the middle
 *   dashed         over the internet, still directly between the two devices
 *   dashed · via   through a relay, which is a server in your file's path
 *   open far end   nobody there yet
 *
 * That mapping is the whole reason the element exists: "local" is an unbroken
 * line because nothing interrupts it, and a relay is drawn with the thing in
 * the middle actually in the middle. Nobody has to learn a legend.
 *
 * A room holds up to eight devices and the protocol is strictly pairwise, so
 * from this device's seat the shape is a hub with independent spokes — never a
 * chain or a shared bus. One leg per device is therefore the honest drawing,
 * and it is what makes "the laptop is on my Wi-Fi but the phone is on mobile
 * data" a thing you can see rather than a thing you have to go and check. A
 * single line summarising several links could only ever have been a guess.
 */
export function Route({state, onOpenDevices}: {state: SessionSnapshot; onOpenDevices: () => void}) {
  const view = read(state)

  const body = (
    <>
      <span className="route__ends">
        <span className="route__end">{state.selfName}</span>
        <span className="route__end route__end--far">{view.far}</span>
      </span>

      <span className="route__fan" aria-hidden="true">
        <span className="route__origin" />
        <span className="route__legs">
          {view.legs.map(leg => (
            <span key={leg.id} className={`route__leg route__leg--${leg.kind}`}>
              {/* The drawn part is one element so that a named leg has exactly
                  two children: the line, and the label. That is what lets every
                  row share a single name column sized to the longest name. */}
              <span className="route__track">
                <span className="route__wire" />
                {/* Drawn only for a relay, and drawn in the middle, because
                    that is where the server actually sits. */}
                {leg.kind === 'relay' && <span className="route__via" />}
                {leg.kind === 'relay' && <span className="route__wire" />}
                <span className={`route__dot ${leg.open ? 'route__dot--open' : ''}`} />
              </span>
              {view.named && <span className="route__leg-name">{leg.name}</span>}
            </span>
          ))}
        </span>
      </span>

      {/* Empty when the path is not known yet. The app's rule everywhere else
          is that a guess about someone's network is worse than saying nothing,
          and the lines are already saying "connected" on their own. */}
      {view.state && <span className="route__state">{view.state}</span>}
    </>
  )

  const className = [
    'route',
    `route--${view.kind}`,
    view.legs.length > 1 ? 'route--many' : '',
    view.named ? 'route--named' : ''
  ]
    .filter(Boolean)
    .join(' ')

  // The live region is this wrapper rather than the route itself, because the
  // route changes element type the moment a device arrives — and a live region
  // that is unmounted and rebuilt announces nothing. The wrapper survives the
  // swap, so "connected" is heard as well as seen.
  return (
    <div className="route-slot" role="status" aria-live="polite">
      {state.peers.length > 0 ? (
        // Interactive only once there is a roster worth opening. A button that
        // opens an empty list is a button that teaches you not to press it.
        <button
          type="button"
          className={`${className} route--live`}
          onClick={onOpenDevices}
          aria-label={`${state.peers.length} device${state.peers.length === 1 ? '' : 's'} connected${
            view.spoken ? `, ${view.spoken}` : ''
          } — show devices`}
        >
          {body}
        </button>
      ) : (
        <div className={className}>{body}</div>
      )}
    </div>
  )
}

/** One link, from this device to one other. */
interface Leg {
  id: string
  name: string
  kind: LegKind
  /** Whether the far dot is a hollow ring — nobody is standing there. */
  open: boolean
}

type LegKind = PathKind | 'waiting' | 'away'

interface RouteView {
  legs: Leg[]
  /** Drives the state line's colour: one kind when they agree, else 'mixed'. */
  kind: LegKind | 'mixed'
  /** Label for the right of the header row. */
  far: string
  /** Whether each leg carries its device's name. */
  named: boolean
  /** The line under the fan, or '' when there is nothing true to say. */
  state: string
  /** The same fact, as a screen reader should hear it. */
  spoken: string
}

/**
 * Past this many devices the names stop fitting on their legs — the legs
 * themselves still fit, so the drawing survives and only the labels fold into
 * the roster. Three named legs stand exactly as tall as the old three-row
 * route, which is the height this screen was already known to afford.
 */
const MAX_NAMED_LEGS = 3

const KIND_WORD: Record<LegKind, string> = {
  local: 'local',
  direct: 'internet',
  relay: 'relayed',
  unknown: 'connecting',
  waiting: 'waiting',
  away: 'reconnecting'
}

/** Fixed, so a tally never reshuffles itself while you are reading it. */
const TALLY_ORDER: LegKind[] = ['local', 'direct', 'relay', 'unknown', 'away', 'waiting']

function read(state: SessionSnapshot): RouteView {
  const peers = state.peers
  if (peers.length === 0) {
    return {
      legs: [{id: 'none', name: '', kind: 'waiting', open: true}],
      kind: 'waiting',
      far: 'No device yet',
      named: false,
      state: 'Scan to connect',
      spoken: ''
    }
  }

  // Roster order, so the legs and the device list they open agree about which
  // device is which.
  const legs: Leg[] = peers.map(peer => ({
    id: peer.id,
    name: peer.name,
    // A device that has dropped outranks whatever its path said a moment ago:
    // a leg to nowhere should not still be drawn as local.
    kind: peer.present ? peer.path.kind : 'away',
    open: !peer.present
  }))

  const kinds = new Set(legs.map(leg => leg.kind))
  const kind = kinds.size === 1 ? legs[0]!.kind : 'mixed'

  if (legs.length === 1) {
    const only = legs[0]!
    // 'unknown' means still classifying: connected, but with nothing to claim.
    const network = only.kind === 'away' ? 'Reconnecting' : peers[0]!.path.network
    const line = only.kind === 'unknown' ? '' : network
    return {legs, kind, far: only.name, named: false, state: line, spoken: line.toLowerCase()}
  }

  const line = tally(legs, peers)
  const named = legs.length <= MAX_NAMED_LEGS
  return {
    legs,
    kind,
    // The count appears exactly when the names do not. With three legs on
    // screen carrying their own labels, "3 devices" is a caption for something
    // you can already see; once the names fold away it is the only thing left
    // that says how many links this is.
    far: named ? '' : `${legs.length} devices`,
    named,
    state: line,
    spoken: line.toLowerCase()
  }
}

/**
 * "2 local · 1 internet" — the shape of the difference rather than the fact of
 * one. When every link agrees there is nothing to count, so it says what they
 * agree on instead.
 */
function tally(legs: Leg[], peers: SessionSnapshot['peers']): string {
  const kinds = new Set(legs.map(leg => leg.kind))
  if (kinds.size === 1) {
    const only = legs[0]!.kind
    if (only === 'unknown') return ''
    if (only === 'away') return 'Reconnecting'
    return peers[0]!.path.network
  }

  const counts = new Map<LegKind, number>()
  for (const leg of legs) counts.set(leg.kind, (counts.get(leg.kind) ?? 0) + 1)

  return TALLY_ORDER.filter(kind => counts.has(kind))
    .map(kind => `${counts.get(kind)} ${KIND_WORD[kind]}`)
    .join(' · ')
}
