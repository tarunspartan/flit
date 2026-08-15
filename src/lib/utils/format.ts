const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

export function formatBytes(bytes: number, fractionDigits?: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1000) return `${Math.round(bytes)} B`
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const digits = fractionDigits ?? (value < 10 ? 2 : value < 100 ? 1 : 0)
  return `${value.toFixed(digits)} ${UNITS[unit]}`
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
  if (seconds < 60) return `${Math.round(seconds)} sec`
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60)
    const secs = Math.round(seconds % 60)
    return secs >= 5 ? `${mins} min ${secs} sec` : `${mins} min`
  }
  const hours = Math.floor(seconds / 3600)
  const mins = Math.round((seconds % 3600) / 60)
  return mins > 0 ? `${hours} hr ${mins} min` : `${hours} hr`
}

export function formatPercent(fraction: number): string {
  return `${Math.floor(Math.min(1, Math.max(0, fraction)) * 100)}%`
}

export function formatShortTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit'
  })
}
