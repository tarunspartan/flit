import type {Bytes} from '../core/bytes.ts'
import {MEMORY_STORE_MAX_BYTES} from '../core/config.ts'
import {AppError} from '../core/errors.ts'
import type {FinalizeResult, ReceiverStore} from './types.ts'

/**
 * Last-resort tier for browsers without OPFS. Hard-capped, because the whole
 * point of the architecture is that a large file never has to fit in RAM
 * (§78) — above the cap we refuse the transfer instead of crashing the tab.
 */
export class MemoryStore implements ReceiverStore {
  readonly kind = 'memory' as const
  #parts = new Map<number, Bytes>()
  #mimeType: string

  private constructor(mimeType: string) {
    this.#mimeType = mimeType
  }

  static canHold(size: number): boolean {
    return size <= MEMORY_STORE_MAX_BYTES
  }

  static open(size: number, mimeType: string): MemoryStore {
    if (!MemoryStore.canHold(size)) {
      throw new AppError(
        'storage-unavailable',
        `file of ${size} bytes exceeds the in-memory ceiling`
      )
    }
    return new MemoryStore(mimeType)
  }

  async write(offset: number, data: Bytes): Promise<void> {
    // Copy: the caller's view points into a transport buffer that gets reused.
    this.#parts.set(offset, data.slice())
  }

  async flush(): Promise<void> {}

  async finalize(): Promise<FinalizeResult> {
    const ordered = [...this.#parts.entries()].sort((a, b) => a[0] - b[0]).map(([, part]) => part)
    return {saved: false, blob: new Blob(ordered as BlobPart[], {type: this.#mimeType})}
  }

  async abort(): Promise<void> {
    this.#parts.clear()
  }
}
