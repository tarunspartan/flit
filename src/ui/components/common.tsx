import type {ReactNode} from 'react'
import type {PathKind} from '../../lib/transport/Transport.ts'
import {bandwidthCost} from '../../lib/transport/pathClassifier.ts'

export function Icon({name, size = 20}: {name: IconName; size?: number}) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}

export type IconName =
  | 'upload'
  | 'download'
  | 'check'
  | 'x'
  | 'pause'
  | 'play'
  | 'retry'
  | 'copy'
  | 'settings'
  | 'link'
  | 'shield'
  | 'chevron'
  | 'sun'
  | 'moon'
  | 'device'
  | 'phone'
  | 'save'
  | 'alert'
  | 'wifi'
  | 'globe'

const PATHS: Record<IconName, ReactNode> = {
  upload: (
    <>
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M4 20h16" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 20h16" />
    </>
  ),
  check: <path d="m4 12 5 5L20 6" />,
  x: (
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </>
  ),
  pause: (
    <>
      <path d="M9 5v14" />
      <path d="M15 5v14" />
    </>
  ),
  play: <path d="M7 4v16l13-8z" />,
  retry: (
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v5h-5" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </>
  ),
  // A real cog: one closed outline with connected teeth. The obvious drawing —
  // a circle with radiating lines — is the same shape as `sun` and reads as a
  // theme toggle instead. Six teeth rather than eight so the valleys stay open
  // at 20px, where a finer gear turns into a blob.
  settings: (
    <>
      <path d="M9.63 5.84L9.65 2.59L14.35 2.59L14.37 5.84L16.15 6.87L18.98 5.26L21.32 9.33L18.52 10.97L18.52 13.03L21.32 14.67L18.98 18.74L16.15 17.13L14.37 18.16L14.35 21.41L9.65 21.41L9.63 18.16L7.85 17.13L5.02 18.74L2.68 14.67L5.48 13.03L5.48 10.97L2.68 9.33L5.02 5.26L7.85 6.87Z" />
      <circle cx="12" cy="12" r="3.4" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 5 6v6c0 4 3 7.5 7 9 4-1.5 7-5 7-9V6z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  chevron: <path d="m6 9 6 6 6-6" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />,
  device: (
    <>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8" />
    </>
  ),
  phone: (
    <>
      <rect x="6" y="2" width="12" height="20" rx="3" />
      <path d="M11 18h2" />
    </>
  ),
  save: (
    <>
      <path d="M5 4h11l3 3v13H5z" />
      <path d="M9 4v5h6V4" />
      <path d="M8 20v-6h8v6" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3 2 20h20z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </>
  ),
  wifi: (
    <>
      <path d="M4.5 11.5a11 11 0 0 1 15 0" />
      <path d="M8 15a6.5 6.5 0 0 1 8 0" />
      <path d="M12 18.5h.01" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18" />
    </>
  )
}

export function ProgressBar({value, state}: {value: number; state?: 'active' | 'done' | 'error'}) {
  const percent = Math.max(0, Math.min(1, value)) * 100
  return (
    <div
      className={`progress progress--${state ?? 'active'}`}
      role="progressbar"
      aria-valuenow={Math.floor(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="progress__fill" style={{width: `${percent}%`}} />
    </div>
  )
}

/**
 * Where these bytes are going, as one pill wherever the path is shown.
 *
 * Four labels and no more: Local network, Internet, Via relay, and Connecting
 * (or Reconnecting, for a device that has dropped). A separate "Direct P2P"
 * badge used to sit beside this in the device list, but with no TURN
 * configured it could only ever read "Direct P2P" — a value that never varies
 * is decoration, not information, and the claim it was making ("no server in
 * the middle") is stated properly in About.
 *
 * Relay is still named rather than folded into "Internet": for bandwidth the
 * two are identical and bandwidthCost is right to collapse them, but a relay
 * means a server is carrying the bytes and that is worth saying. It cannot
 * happen with this app's own configuration; a peer running one with TURN
 * would still be reported honestly.
 */
export function PathCost({kind, away = false}: {kind: PathKind; away?: boolean}) {
  const cost = bandwidthCost(kind)
  const pending = away || cost === null
  const local = cost === 'local'
  const relayed = kind === 'relay'

  // "Connected" rather than "Connecting" while the path is still unknown. The
  // device is connected — that happened before this badge existed — and only
  // *how* it is reachable is outstanding. Saying "Connecting" for the seconds
  // ICE takes to settle understated a link that was already carrying files.
  const label = away
    ? 'Reconnecting'
    : pending
      ? 'Connected'
      : relayed
        ? 'Via relay'
        : local
          ? 'Local network'
          : 'Internet'

  return (
    <span
      className="pathcost"
      title={
        away
          ? 'Trying to reach this device again'
          : pending
            ? 'Connected — still working out which network the bytes take'
            : relayed
              ? 'Travelling through a relay server, which can see the connection but not the contents'
              : local
                ? 'Travelling over your own network — this does not use your internet data'
                : 'Travelling over the internet — this uses your connection'
      }
    >
      <Icon name={away ? 'retry' : pending ? 'device' : local ? 'wifi' : 'globe'} size={13} />
      {label}
    </span>
  )
}

export function Spinner({label}: {label?: string}) {
  return (
    <span className="spinner-wrap">
      <span className="spinner" aria-hidden="true" />
      {label && <span>{label}</span>}
    </span>
  )
}
