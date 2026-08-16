import type {ReactNode} from 'react'
import type {PathKind} from '../../lib/transport/Transport.ts'

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

const PATH_LABEL: Record<PathKind, string> = {
  local: 'Direct P2P',
  direct: 'Direct P2P',
  relay: 'Relayed P2P',
  unknown: 'Connecting'
}

/** The trust signal from §63: visible, but only three states to understand. */
export function PathBadge({
  kind,
  network,
  compact
}: {
  kind: PathKind
  network: string
  compact?: boolean
}) {
  return (
    // The gap between the two labels is flex spacing, not a text node, so the
    // element's own text runs them together. Screen readers get the label.
    <span
      className={`badge badge--${kind}`}
      title={`${PATH_LABEL[kind]} · ${network}`}
      aria-label={compact ? PATH_LABEL[kind] : `${PATH_LABEL[kind]}, ${network}`}
    >
      {/* One dot, one meaning. A separator dot next to the status dot read as
          two dots that disagree about their size rather than as punctuation;
          the network reads as secondary from its weight instead. */}
      <span className="badge__dot" aria-hidden="true" />
      {PATH_LABEL[kind]}
      {!compact && <span className="badge__network">{network}</span>}
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
