import {PERSIST_MIN_BYTES, PICKER_MIN_BYTES} from '../core/config.ts'
import {AppError} from '../core/errors.ts'
import {requestPersistentStorage} from './estimate.ts'
import {FileSystemStore} from './FileSystemStore.ts'
import {MemoryStore} from './MemoryStore.ts'
import {OpfsStore, opfsSupported} from './OpfsStore.ts'
import type {ReceiverStore, StoreKind, StoreRequest} from './types.ts'

export {purgeOpfs} from './OpfsStore.ts'
export type {ReceiverStore, StoreKind} from './types.ts'

export interface StoragePreferences {
  /** Always offer the save picker, regardless of file size. */
  alwaysChooseLocation: boolean
}

/**
 * Whether a file this size will be written to a location the user picks rather
 * than into this origin's storage bucket.
 *
 * Exported because the capacity advice shown *before* accepting has to make the
 * same call the store makes afterwards. `navigator.storage.estimate()` reports
 * an origin quota, not free disk, and a file streamed to a chosen location
 * never touches that quota — so judging one against it produced "This device
 * may not have room" for a file on a disk with plenty of room to spare.
 */
/**
 * Whether this browser can write a download straight to a location the user
 * picks, bypassing the origin's storage allowance altogether.
 *
 * False on Firefox, on iOS, and on Android Chrome — there the allowance is a
 * real ceiling on what can be received, and advice to "save it to disk
 * instead" would be advice to press a button that does not exist.
 */
export function canChooseLocation(): boolean {
  return FileSystemStore.supported()
}

export function usesChosenLocation(size: number, prefs: StoragePreferences): boolean {
  return FileSystemStore.supported() && (prefs.alwaysChooseLocation || size >= PICKER_MIN_BYTES)
}

/**
 * Picks the best available tier (§78):
 *   1. user-chosen location  — one write, no quota, best for huge files
 *   2. OPFS                  — off-main-thread, bounded RAM, then download
 *   3. memory                — small files only, hard-capped
 */
export async function createReceiverStore(
  request: StoreRequest,
  prefs: StoragePreferences = {alwaysChooseLocation: false}
): Promise<ReceiverStore> {
  const wantsPicker = request.allowPicker && usesChosenLocation(request.size, prefs)

  if (wantsPicker) {
    // Returns null if the user dismisses the dialog: they accepted the
    // transfer, so keep going with OPFS rather than failing it.
    const store = await FileSystemStore.open(request.filename, request.mimeType)
    if (store) return store
  }

  if (opfsSupported()) {
    // OPFS is evictable. A browser under storage pressure can drop a partial
    // file, taking the durable checkpoint with it, and a resume then has
    // nothing to resume from. Deliberately not awaited: whether the browser
    // agrees changes nothing about how we write, so it must not be able to
    // delay or fail the transfer.
    if (request.size >= PERSIST_MIN_BYTES) void requestPersistentStorage()
    try {
      return await OpfsStore.open(request.filename)
    } catch (err) {
      if (MemoryStore.canHold(request.size)) return MemoryStore.open(request.size, request.mimeType)
      throw err
    }
  }

  if (MemoryStore.canHold(request.size)) return MemoryStore.open(request.size, request.mimeType)

  throw new AppError(
    'storage-unavailable',
    'no streaming storage backend is available in this browser'
  )
}

export interface StorageSupport {
  tiers: StoreKind[]
  best: StoreKind
  /** Largest file this browser can receive at all. */
  streamingCapable: boolean
}

export function describeStorageSupport(): StorageSupport {
  const tiers: StoreKind[] = []
  if (FileSystemStore.supported()) tiers.push('filesystem')
  if (opfsSupported()) tiers.push('opfs')
  tiers.push('memory')
  return {
    tiers,
    best: tiers[0] ?? 'memory',
    streamingCapable: tiers[0] === 'filesystem' || tiers[0] === 'opfs'
  }
}

/** Hands the finished file to the user when it isn't already on disk. */
export function triggerDownload(blob: Blob, filename: string): void {
  // No DOM (tests, workers): the caller keeps the blob and offers Save instead.
  if (typeof document === 'undefined') return
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // Revoking immediately can cancel the download on some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
