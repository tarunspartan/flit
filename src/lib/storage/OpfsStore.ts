import type {Bytes} from '../core/bytes.ts'
import {AppError} from '../core/errors.ts'
import {randomId} from '../core/ids.ts'
import type {FinalizeResult, ReceiverStore} from './types.ts'

/** Every received file lives under here, in a folder per page. */
const OPFS_DIR = 'flit-incoming'

/**
 * This page's own folder.
 *
 * Per page, because the startup purge used to delete the whole of
 * `flit-incoming` — so opening a second tab, or reloading one, destroyed the
 * other tab's received files mid-download and broke its "Save again". Now each
 * page holds a Web Lock named after its folder for as long as it lives, and the
 * purge only removes folders whose lock nobody holds.
 */
const TAB_DIR = `${Date.now().toString(36)}-${randomId(4)}`
const LOCK_PREFIX = 'flit-opfs:'

/**
 * Without Web Locks (Safari before 15.4) there is no way to tell a live page
 * from a dead one, so only folders older than this are treated as abandoned.
 */
const STALE_WITHOUT_LOCKS_MS = 24 * 60 * 60 * 1000

/**
 * A finished file stays readable for this long after it is released: the
 * browser may still be copying it into Downloads, and deleting the bytes under
 * a download in progress fails it. Anything still here when the page closes is
 * collected by the next page's purge.
 */
const FINISHED_FILE_GRACE_MS = 10 * 60 * 1000

let tabLock: Promise<void> | null = null

/** Takes this page's lock, resolving once it is held. Idempotent. */
function holdTabLock(): Promise<void> {
  tabLock ??= new Promise<void>(granted => {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
    if (!locks) {
      granted()
      return
    }
    // The callback's promise never settles, so the lock is held until the
    // page goes away — which is exactly when its folder becomes collectable.
    locks
      .request(LOCK_PREFIX + TAB_DIR, () => {
        granted()
        return new Promise<never>(() => {})
      })
      .catch(() => granted())
  })
  return tabLock
}

type Pending = {resolve: (value: {file?: File}) => void; reject: (err: Error) => void}

/**
 * Main-thread side of the one OPFS worker this page uses.
 *
 * Shared by every OpfsStore. If the worker dies, everything it was doing fails
 * and the next store starts a fresh one.
 */
class OpfsWorker {
  static #current: OpfsWorker | null = null

  static get(): OpfsWorker {
    OpfsWorker.#current ??= new OpfsWorker()
    return OpfsWorker.#current
  }

  #worker: Worker
  #pending = new Map<number, Pending>()
  #nextId = 1
  #nextFile = 1

  private constructor() {
    this.#worker = new Worker(new URL('./opfsWorker.ts', import.meta.url), {
      type: 'module',
      name: 'flit-opfs'
    })
    this.#worker.onmessage = (event: MessageEvent) => {
      const {id, ok, error, file} = event.data as {id: number; ok: boolean; error?: string; file?: File}
      const pending = this.#pending.get(id)
      if (!pending) return
      this.#pending.delete(id)
      if (ok) pending.resolve({file})
      else pending.reject(new Error(error ?? 'OPFS worker error'))
    }
    this.#worker.onerror = event => {
      if (OpfsWorker.#current === this) OpfsWorker.#current = null
      const err = new Error(event.message || 'OPFS worker crashed')
      for (const pending of this.#pending.values()) pending.reject(err)
      this.#pending.clear()
    }
  }

  fileId(): number {
    return this.#nextFile++
  }

  send(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<{file?: File}> {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, {resolve, reject})
      this.#worker.postMessage({...message, id}, transfer)
    })
  }
}

export function opfsSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof Worker !== 'undefined'
  )
}

/**
 * Deletes what earlier pages left behind — killed mid-transfer, or closed with
 * a finished file still in storage — and never what a live page is using.
 */
export async function purgeOpfs(): Promise<void> {
  if (!opfsSupported()) return
  await holdTabLock()
  try {
    const root = await navigator.storage.getDirectory()
    const incoming = await root.getDirectoryHandle(OPFS_DIR).catch(() => null)
    if (!incoming) return
    const live = await liveTabs()
    const entries = (incoming as unknown as {entries(): AsyncIterable<[string, FileSystemHandle]>}).entries()
    const doomed: string[] = []
    for await (const [name, handle] of entries) {
      if (name === TAB_DIR) continue
      // Loose files come from builds before per-page folders. One still open by
      // such a page is locked, and the removal below simply fails.
      if (handle.kind === 'directory' && (live ? live.has(name) : !isStale(name))) continue
      doomed.push(name)
    }
    for (const name of doomed) await incoming.removeEntry(name, {recursive: true}).catch(() => {})
  } catch {
    // Best effort — a stale file is not worth blocking startup over.
  }
}

/** Folders whose page is still open, or null when that cannot be known. */
async function liveTabs(): Promise<Set<string> | null> {
  if (!navigator.locks) return null
  try {
    const {held = []} = await navigator.locks.query()
    return new Set(
      held
        .map(lock => lock.name ?? '')
        .filter(name => name.startsWith(LOCK_PREFIX))
        .map(name => name.slice(LOCK_PREFIX.length))
    )
  } catch {
    return null
  }
}

function isStale(folder: string): boolean {
  const createdAt = parseInt(folder.split('-')[0] ?? '', 36)
  return !Number.isFinite(createdAt) || Date.now() - createdAt > STALE_WITHOUT_LOCKS_MS
}

export class OpfsStore implements ReceiverStore {
  readonly kind = 'opfs' as const
  #worker: OpfsWorker
  #file: number
  #state: 'open' | 'finalized' | 'gone' = 'open'

  private constructor(worker: OpfsWorker, file: number) {
    this.#worker = worker
    this.#file = file
  }

  static async open(filename: string): Promise<OpfsStore> {
    if (!opfsSupported()) throw new AppError('storage-unavailable', 'OPFS not available')
    // Hold the lock before the folder exists, so no other page's purge can
    // ever see it unprotected.
    await holdTabLock()
    const worker = OpfsWorker.get()
    const file = worker.fileId()
    try {
      await worker.send({
        op: 'open',
        file,
        dir: [OPFS_DIR, TAB_DIR],
        // Prefixed so two files with one name — from two devices — cannot collide.
        name: `${file}-${filename}`
      })
    } catch (err) {
      throw new AppError('storage-unavailable', 'could not open OPFS file', {cause: err})
    }
    return new OpfsStore(worker, file)
  }

  async write(offset: number, data: Bytes): Promise<void> {
    // Handed over, not copied, when the view is the whole of its buffer — as a
    // received frame is, give or take its header. A view into something larger
    // is copied rather than detaching bytes that belong to someone else.
    const owned = data.buffer.byteLength - data.byteLength <= 64
    const buffer = owned ? data.buffer : data.slice().buffer
    const byteOffset = owned ? data.byteOffset : 0
    try {
      await this.#worker.send(
        {op: 'write', file: this.#file, offset, data: buffer, byteOffset, byteLength: data.byteLength},
        [buffer]
      )
    } catch (err) {
      throw asStorageError(err)
    }
  }

  async flush(): Promise<void> {
    try {
      await this.#worker.send({op: 'flush', file: this.#file})
    } catch (err) {
      throw asStorageError(err)
    }
  }

  async finalize(): Promise<FinalizeResult> {
    try {
      const {file} = await this.#worker.send({op: 'finalize', file: this.#file})
      if (!file) throw new AppError('finalize-failed', 'worker returned no file')
      this.#state = 'finalized'
      return {saved: false, blob: file}
    } catch (err) {
      throw err instanceof AppError ? err : new AppError('finalize-failed', String(err), {cause: err})
    }
  }

  async abort(): Promise<void> {
    // A finalized file is not partial data; it is what "Save again" reads.
    if (this.#state !== 'open') return
    this.#state = 'gone'
    await this.#worker.send({op: 'abort', file: this.#file}).catch(() => {})
  }

  async release(): Promise<void> {
    if (this.#state === 'open') {
      await this.abort()
      return
    }
    if (this.#state !== 'finalized') return
    this.#state = 'gone'
    setTimeout(() => {
      void this.#worker.send({op: 'remove', file: this.#file}).catch(() => {})
    }, FINISHED_FILE_GRACE_MS)
  }
}

function asStorageError(err: unknown): AppError {
  const text = err instanceof Error ? err.message : String(err)
  if (/quota|space|storage/i.test(text)) {
    return new AppError('storage-full', text, {cause: err})
  }
  return new AppError('finalize-failed', text, {cause: err})
}
