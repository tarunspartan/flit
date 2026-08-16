/**
 * The page half of the Web Share Target flow (public/share-target.js holds the
 * service worker half).
 *
 * When someone picks flit from the OS share sheet, the service worker parks the
 * shared files in a cache and redirects here with a marker in the query string.
 * This module notices the marker and hands the files back.
 *
 * Chromium supports this once the app is installed — Android, ChromeOS and
 * Windows. macOS and iOS do not: neither wires a web app into the system share
 * sheet, so on a Mac or an iPhone these functions simply never find anything.
 * Nothing to feature-detect, nothing to fail.
 */

/** Must match SHARE_CACHE in public/share-target.js. */
const SHARE_CACHE = 'flit-shared-v1'
const MARKER = 'shared'

/**
 * Whether this page load came from the share sheet, clearing the marker as it
 * goes so a reload doesn't look like a second share.
 */
export function cameFromShare(): boolean {
  const params = new URLSearchParams(location.search)
  if (!params.has(MARKER)) return false

  params.delete(MARKER)
  const query = params.toString()
  history.replaceState(null, '', location.pathname + (query ? `?${query}` : '') + location.hash)
  return true
}

/**
 * Collects the shared files and clears the cache behind them.
 *
 * The cache is emptied whatever happens: these are copies of files the user
 * already has, and leaving them in storage after a failed handoff would be a
 * silent hoard of someone's photos.
 */
export async function takeSharedFiles(): Promise<File[]> {
  if (typeof caches === 'undefined') return []

  try {
    const cache = await caches.open(SHARE_CACHE)
    const keys = await cache.keys()

    const entries = await Promise.all(
      keys.map(async key => {
        const response = await cache.match(key)
        if (!response) return null
        const blob = await response.blob()
        return {order: orderOf(key.url), file: toFile(blob, response.headers)}
      })
    )

    return entries
      .filter((entry): entry is {order: number; file: File} => entry !== null)
      .sort((a, b) => a.order - b.order)
      .map(entry => entry.file)
  } catch {
    return []
  } finally {
    await caches.delete(SHARE_CACHE).catch(() => {})
  }
}

function toFile(blob: Blob, headers: Headers): File {
  let name = 'shared-file'
  try {
    name = decodeURIComponent(headers.get('x-share-name') ?? '') || name
  } catch {
    // A malformed escape sequence is not worth losing the file over.
  }
  const modified = Number(headers.get('x-share-modified'))
  return new File([blob], name, {
    type: blob.type,
    lastModified: Number.isFinite(modified) && modified > 0 ? modified : Date.now()
  })
}

/** Share order is carried in the cache key, since cache.keys() is unordered. */
function orderOf(url: string): number {
  const index = Number(url.split('/').pop())
  return Number.isFinite(index) ? index : 0
}
