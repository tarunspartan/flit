import type {Bytes} from '../core/bytes.ts'
import {AppError} from '../core/errors.ts'
import type {FinalizeResult, ReceiverStore} from './types.ts'

type Pending = {resolve: (value: {file?: File}) => void; reject: (err: Error) => void}

/**
 * Main-thread proxy for opfsWorker. Chunk buffers are transferred (not copied)
 * so a 256 KiB write costs no extra allocation.
 */
class OpfsWriter {
  #worker: Worker
  #pending = new Map<number, Pending>()
  #nextId = 1

  constructor() {
    this.#worker = new Worker(new URL('./opfsWorker.ts', import.meta.url), {
      type: 'module',
      name: 'flit-opfs'
    })
    this.#worker.onmessage = (event: MessageEvent) => {
      const {id, ok, error, file} = event.data as {
        id: number
        ok: boolean
        error?: string
        file?: File
      }
      const pending = this.#pending.get(id)
      if (!pending) return
      this.#pending.delete(id)
      if (ok) pending.resolve({file})
      else pending.reject(new Error(error ?? 'OPFS worker error'))
    }
    this.#worker.onerror = event => {
      const err = new Error(event.message || 'OPFS worker crashed')
      for (const pending of this.#pending.values()) pending.reject(err)
      this.#pending.clear()
    }
  }

  send(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<{file?: File}> {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, {resolve, reject})
      this.#worker.postMessage({...message, id}, transfer)
    })
  }

  terminate(): void {
    this.#worker.terminate()
    for (const pending of this.#pending.values()) {
      pending.reject(new Error('worker terminated'))
    }
    this.#pending.clear()
  }
}

export function opfsSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof Worker !== 'undefined'
  )
}

/** Deletes anything left behind by a session that was killed mid-transfer. */
export async function purgeOpfs(): Promise<void> {
  if (!opfsSupported()) return
  const writer = new OpfsWriter()
  try {
    await writer.send({op: 'purge'})
  } catch {
    // Best effort — a stale temp file is not worth blocking startup over.
  } finally {
    writer.terminate()
  }
}

export class OpfsStore implements ReceiverStore {
  readonly kind = 'opfs' as const
  #writer: OpfsWriter
  #done = false

  private constructor(writer: OpfsWriter) {
    this.#writer = writer
  }

  static async open(filename: string): Promise<OpfsStore> {
    if (!opfsSupported()) throw new AppError('storage-unavailable', 'OPFS not available')
    const writer = new OpfsWriter()
    try {
      // Namespaced so two concurrent transfers of the same filename don't collide.
      await writer.send({op: 'open', name: `${Date.now().toString(36)}-${filename}`})
    } catch (err) {
      writer.terminate()
      throw new AppError('storage-unavailable', 'could not open OPFS file', {cause: err})
    }
    return new OpfsStore(writer)
  }

  async write(offset: number, data: Bytes): Promise<void> {
    // Copy into a standalone buffer so it can be transferred to the worker
    // without detaching the caller's view of the received frame.
    const buffer = data.slice().buffer
    try {
      await this.#writer.send({op: 'write', offset, data: buffer}, [buffer])
    } catch (err) {
      throw asStorageError(err)
    }
  }

  async flush(): Promise<void> {
    try {
      await this.#writer.send({op: 'flush'})
    } catch (err) {
      throw asStorageError(err)
    }
  }

  async finalize(): Promise<FinalizeResult> {
    try {
      const {file} = await this.#writer.send({op: 'finalize'})
      if (!file) throw new AppError('finalize-failed', 'worker returned no file')
      this.#done = true
      return {saved: false, blob: file}
    } catch (err) {
      throw err instanceof AppError ? err : new AppError('finalize-failed', String(err), {cause: err})
    }
  }

  async abort(): Promise<void> {
    if (this.#done) {
      // The File handed to the caller still reads from this entry; leave the
      // bytes in place and let the next session's purge collect them.
      this.#writer.terminate()
      return
    }
    try {
      await this.#writer.send({op: 'abort'})
    } catch {
      // Nothing useful to do; the purge on next startup covers it.
    } finally {
      this.#writer.terminate()
    }
  }

  /** Releases the worker once the caller is done reading the finalized File. */
  release(): void {
    this.#writer.terminate()
  }
}

function asStorageError(err: unknown): AppError {
  const text = err instanceof Error ? err.message : String(err)
  if (/quota|space|storage/i.test(text)) {
    return new AppError('storage-full', text, {cause: err})
  }
  return new AppError('finalize-failed', text, {cause: err})
}
