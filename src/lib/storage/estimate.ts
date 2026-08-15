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

/**
 * Asks for persistent storage so the browser does not evict a partially
 * received file under pressure. Silently best-effort.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator?.storage?.persist !== 'function') return false
  try {
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}
