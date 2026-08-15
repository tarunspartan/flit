/**
 * Binary chunk framing.
 *
 * A 16-byte header rides in front of every chunk payload. `seq` is a compact
 * per-session transfer id (the string transferId stays in the JSON control
 * channel) and `index` makes chunks self-locating, so the receiver can write at
 * a computed offset and duplicates are harmless (§73.3).
 */

import type {Bytes} from '../core/bytes.ts'

export const FRAME_HEADER_BYTES = 16
export const FRAME_VERSION = 1

export interface ChunkFrame {
  version: number
  seq: number
  index: number
  payload: Bytes
}

export function encodeChunk(seq: number, index: number, payload: Bytes): Bytes {
  const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength)
  const view = new DataView(frame.buffer)
  view.setUint8(0, FRAME_VERSION)
  view.setUint8(1, 0) // flags, reserved
  view.setUint16(2, seq, false)
  view.setUint32(4, index, false)
  view.setUint32(8, payload.byteLength, false)
  view.setUint32(12, 0, false) // reserved
  frame.set(payload, FRAME_HEADER_BYTES)
  return frame
}

/** Returns null for anything malformed — never throws on peer input. */
export function decodeChunk(data: unknown, maxPayload: number): ChunkFrame | null {
  // The single place a buffer from outside the app becomes a typed `Bytes`.
  let bytes: Bytes
  if (data instanceof Uint8Array) bytes = data as Bytes
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data)
  else if (ArrayBuffer.isView(data)) {
    bytes = new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength)
  } else return null

  if (bytes.byteLength < FRAME_HEADER_BYTES) return null

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint8(0)
  const seq = view.getUint16(2, false)
  const index = view.getUint32(4, false)
  const length = view.getUint32(8, false)

  // The declared length must match what actually arrived, and stay within the
  // chunk size the offer promised.
  if (length > maxPayload) return null
  if (bytes.byteLength !== FRAME_HEADER_BYTES + length) return null

  return {
    version,
    seq,
    index,
    payload: bytes.subarray(FRAME_HEADER_BYTES)
  }
}
