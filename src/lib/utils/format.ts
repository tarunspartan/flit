const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

/**
 * A value and its unit are one thing to read, so they are joined by a
 * non-breaking space and never wrapped apart.
 */
const NBSP = '\u00a0'

/**
 * Locale-aware decimals: `toFixed` always writes a full stop, which is the
 * wrong separator in most of Europe. Cached per digit count because this runs
 * for every row on every progress tick, and building an Intl formatter is not
 * cheap.
 */
const DECIMALS = new Map<number, Intl.NumberFormat>()

function decimal(digits: number): Intl.NumberFormat {
  let formatter = DECIMALS.get(digits)
  if (!formatter) {
    formatter = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    })
    DECIMALS.set(digits, formatter)
  }
  return formatter
}

export function formatBytes(bytes: number, fractionDigits?: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1000) return `${decimal(0).format(Math.round(bytes))}${NBSP}B`
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const digits = fractionDigits ?? (value < 10 ? 2 : value < 100 ? 1 : 0)
  return `${decimal(digits).format(value)}${NBSP}${UNITS[unit]}`
}

export function formatSpeed(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond)) return '—'
  return `${formatBytes(bytesPerSecond, bytesPerSecond < 10 * 1024 ** 2 ? 1 : 0)}/s`
}

/**
 * Deliberately coarse: a countdown that ticks every second reads as precision
 * the estimate does not have.
 */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return 'Calculating…'
  if (seconds < 1) return 'less than a second'
  if (seconds < 60) return `${Math.round(seconds)}${NBSP}sec`
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60)
    const secs = Math.round(seconds % 60)
    return secs >= 5 ? `${mins}${NBSP}min ${secs}${NBSP}sec` : `${mins}${NBSP}min`
  }
  const hours = Math.floor(seconds / 3600)
  const mins = Math.round((seconds % 3600) / 60)
  return mins > 0 ? `${hours}${NBSP}hr ${mins}${NBSP}min` : `${hours}${NBSP}hr`
}

export function formatPercent(fraction: number): string {
  return `${Math.floor(Math.min(1, Math.max(0, fraction)) * 100)}%`
}
