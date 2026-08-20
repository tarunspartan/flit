/**
 * Storage awareness (spec §66.9, §78.2): warn before a huge transfer starts,
 * not after 18 GB have already been received.
 */

export interface StorageEstimate {
  quota: number
  usage: number
  available: number
}

export async function getStorageEstimate(): Promise<StorageEstimate | null> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.estimate !== 'function') {
    return null
  }
  try {
    const {quota = 0, usage = 0} = await navigator.storage.estimate()
    return {quota, usage, available: Math.max(0, quota - usage)}
  } catch {
    return null
  }
}

export type CapacityVerdict = 'ok' | 'tight' | 'insufficient' | 'unknown'

export interface CapacityCheck {
  verdict: CapacityVerdict
  available: number | null
  /** Advisory only when the file streams to a user-chosen location. */
  appliesToQuota: boolean
}

/**
 * Browsers report an origin quota, not free disk space, so this is advice
 * rather than a guarantee — hence 'tight' instead of a hard block.
 */
export async function checkCapacity(bytes: number, appliesToQuota = true): Promise<CapacityCheck> {
  const estimate = await getStorageEstimate()
  if (!estimate || estimate.quota === 0) {
    return {verdict: 'unknown', available: null, appliesToQuota}
  }
  const {available} = estimate
  if (!appliesToQuota) return {verdict: 'ok', available, appliesToQuota}
  if (bytes > available) return {verdict: 'insufficient', available, appliesToQuota}
  // Leave headroom: the download step may briefly need a second copy.
  if (bytes > available * 0.8) return {verdict: 'tight', available, appliesToQuota}
  return {verdict: 'ok', available, appliesToQuota}
}

let pending: Promise<boolean> | null = null

/**
 * Asks the browser not to evict this origin's storage, so a partially received
 * file — and the checkpoint a resume would restart from — survives storage
 * pressure. Silently best-effort: the answer changes nothing about how we
 * write, only whether the bytes are safe from eviction.
 *
 * Asked at most once per page. Firefox shows a permission prompt for this, and
 * one per file would be its own kind of broken; Chrome decides silently from
 * engagement heuristics and would not prompt either way.
 */
export function requestPersistentStorage(): Promise<boolean> {
  pending ??= askToPersist()
  return pending
}

async function askToPersist(): Promise<boolean> {
  // `navigator` is not merely undefined in a worker or in tests — referencing
  // an undeclared identifier throws, which optional chaining does not catch.
  if (typeof navigator === 'undefined' || typeof navigator.storage?.persist !== 'function') {
    return false
  }
  try {
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}
