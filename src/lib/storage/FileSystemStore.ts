import type {Bytes} from '../core/bytes.ts'
import {AppError} from '../core/errors.ts'
import type {FinalizeResult, ReceiverStore} from './types.ts'

/**
 * Streams straight to a location the user picks (File System Access API).
 *
 * This is the best path for very large files: the bytes land at their final
 * destination once, instead of filling OPFS and then being copied again by a
 * browser download.
 */
export class FileSystemStore implements ReceiverStore {
  readonly kind = 'filesystem' as const
  #writable: FileSystemWritableFileStream
  #closed = false

  private constructor(writable: FileSystemWritableFileStream) {
    this.#writable = writable
  }

  static supported(): boolean {
    return typeof (globalThis as {showSaveFilePicker?: unknown}).showSaveFilePicker === 'function'
  }

  /**
   * Must be called synchronously enough after a user gesture (the Accept tap)
   * for the picker to open. Returns null when the user dismisses the dialog, so
   * the caller can fall back rather than failing the transfer.
   */
  static async open(filename: string, mimeType: string): Promise<FileSystemStore | null> {
    if (!FileSystemStore.supported()) return null
    const showSaveFilePicker = (
      globalThis as unknown as {
        showSaveFilePicker: (options: unknown) => Promise<FileSystemFileHandle>
      }
    ).showSaveFilePicker

    let handle: FileSystemFileHandle
    try {
      handle = await showSaveFilePicker({
        suggestedName: filename,
        types: mimeType
          ? [{description: 'File', accept: {[mimeType]: [extensionOf(filename)]}}]
          : undefined
      })
    } catch (err) {
      // AbortError means "I'd rather not choose a location" — not a failure.
      if (err instanceof DOMException && err.name === 'AbortError') return null
      return null
    }

    try {
      const writable = await handle.createWritable({keepExistingData: false})
      return new FileSystemStore(writable)
    } catch (err) {
      throw new AppError('storage-unavailable', 'could not open the chosen file for writing', {
        cause: err
      })
    }
  }

  async write(offset: number, data: Bytes): Promise<void> {
    try {
      await this.#writable.write({type: 'write', position: offset, data})
    } catch (err) {
      throw quotaAware(err)
    }
  }

  async flush(): Promise<void> {
    // Writes are already handed to the stream; there is no separate sync point
    // before close(), which is exactly why close() is the finalization step.
  }

  async finalize(): Promise<FinalizeResult> {
    try {
      await this.#writable.close()
      this.#closed = true
      return {saved: true}
    } catch (err) {
      throw new AppError('finalize-failed', err instanceof Error ? err.message : String(err), {
        cause: err
      })
    }
  }

  async abort(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    // abort() discards the swap file, so no half-written file is left behind.
    await this.#writable.abort().catch(() => {})
  }
}

function extensionOf(filename: string): string[] {
  const dot = filename.lastIndexOf('.')
  return dot > 0 ? [filename.slice(dot)] : []
}

function quotaAware(err: unknown): AppError {
  if (err instanceof DOMException && (err.name === 'QuotaExceededError' || err.name === 'NotAllowedError')) {
    return new AppError(err.name === 'QuotaExceededError' ? 'storage-full' : 'storage-unavailable', err.message, {
      cause: err
    })
  }
  const text = err instanceof Error ? err.message : String(err)
  return new AppError(/quota|space/i.test(text) ? 'storage-full' : 'finalize-failed', text, {cause: err})
}
