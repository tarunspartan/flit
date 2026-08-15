/**
 * Web Share Target receiver.
 *
 * Pulled into the generated service worker (vite.config.ts → workbox
 * .importScripts). It stays plain JS in public/ on purpose: the service worker
 * needs it as a standalone script at a stable URL, so it never goes through the
 * bundler and cannot import from src/.
 *
 * The OS delivers a share as a POST with multipart form data. A page can't read
 * that body — the request is consumed by the navigation — so the service worker
 * takes the files, parks them in a cache, and redirects to the app, which
 * collects them on boot. See src/lib/utils/shareTarget.ts for that half.
 *
 * Workbox's own routes are all GET, so a POST never reaches them and there is
 * no contest over who answers this request.
 */

/** Must match SHARE_CACHE in src/lib/utils/shareTarget.ts. */
const SHARE_CACHE = 'flit-shared-v1'

/** Resolved against the worker's own scope so a subpath deploy works unchanged. */
const scoped = path => new URL(path, self.registration.scope).href

self.addEventListener('fetch', event => {
  if (event.request.method !== 'POST') return
  if (new URL(event.request.url).pathname !== new URL(scoped('share')).pathname) return
  event.respondWith(receiveShare(event.request))
})

async function receiveShare(request) {
  try {
    const form = await request.formData()
    const files = form.getAll('files').filter(entry => entry instanceof File)
    if (files.length === 0) return Response.redirect(scoped('./'), 303)

    // Drop anything a previous share left behind rather than merging into it —
    // an abandoned share must not reappear attached to this one.
    await caches.delete(SHARE_CACHE)
    const cache = await caches.open(SHARE_CACHE)

    await Promise.all(
      files.map((file, index) =>
        cache.put(
          // Cache keys must be GET requests; the index preserves share order.
          new Request(scoped(`shared-file/${index}`)),
          new Response(file, {
            headers: {
              'content-type': file.type || 'application/octet-stream',
              // Header values are ASCII, and a filename is not.
              'x-share-name': encodeURIComponent(file.name),
              'x-share-modified': String(file.lastModified)
            }
          })
        )
      )
    )

    // 303 so the browser follows up with a GET; a plain 302 would repeat the POST.
    return Response.redirect(scoped('./?shared=1'), 303)
  } catch {
    // A share that can't be read still has to land somewhere sensible.
    return Response.redirect(scoped('./'), 303)
  }
}
