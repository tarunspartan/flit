import type {Bytes} from '../core/bytes.ts'

/**
 * Receiver-side storage (spec §78). Incoming bytes must never accumulate in RAM
 * for large files, and an incomplete file must never be presented as complete.
 */

export type StoreKind = 'filesystem' | 'opfs' | 'memory'

export interface FinalizeResult {
  /** True when bytes already landed at their final destination on disk. */
  saved: boolean
  /** Present when the app still has to hand the user a download. */
  blob?: Blob
}

export interface ReceiverStore {
  readonly kind: StoreKind
  /**
   * Writes at an absolute offset; safe to call with duplicate offsets.
   *
   * Takes ownership of `data`: the caller must not read it afterwards, which
   * lets a store hand the buffer to a worker instead of copying it.
   */
  write(offset: number, data: Bytes): Promise<void>
  /** Makes prior writes durable enough to checkpoint against. */
  flush(): Promise<void>
  /** Called only after integrity verification passes. */
  finalize(): Promise<FinalizeResult>
  /** Discards partial data. Always safe to call, including twice. */
  abort(): Promise<void>
  /**
   * Frees whatever the store still holds once nobody needs the file — the
   * finalized copy too. Safe after abort, and safe to call twice.
   */
  release(): Promise<void>
}

export interface StoreRequest {
  filename: string
  size: number
  mimeType: string
  /**
   * True when we're inside a user gesture and may show a save picker, which
   * streams straight to the user's chosen location.
   */
  allowPicker: boolean
}
