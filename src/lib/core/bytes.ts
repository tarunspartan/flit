/**
 * TypeScript models `Uint8Array` as generic over its backing buffer, and
 * `BufferSource` only accepts views over a real `ArrayBuffer` (not a
 * `SharedArrayBuffer`). Every buffer in this app is a plain ArrayBuffer, so we
 * name that once here instead of casting at each Web Crypto / filesystem call.
 */
export type Bytes = Uint8Array<ArrayBuffer>

/** Narrows a view that arrived from an external API we know is unshared. */
export function asBytes(view: Uint8Array): Bytes {
  return view as Bytes
}
