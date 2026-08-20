/**
 * Strict validation of everything a peer sends (spec §75.2: "malformed protocol
 * messages", "oversized metadata"). Anything that fails is dropped rather than
 * coerced — a message we don't fully understand never reaches the state machine.
 */
import {LIMITS} from '../core/config.ts'
import {PATH_KINDS} from '../transport/Transport.ts'
import {
  MIN_COMPATIBLE_VERSION,
  PROTOCOL_VERSION,
  type ControlMessage,
  type MessageType
} from './messages.ts'

export type ParseResult =
  | {ok: true; message: ControlMessage}
  | {ok: false; reason: 'malformed' | 'incompatible-version' | 'too-large'}

const MAX_STRING = 1024
const MAX_CHUNK_SIZE = 1024 * 1024
const MIN_CHUNK_SIZE = 4 * 1024
const MAX_TOTAL_CHUNKS = 20_000_000

type Rec = Record<string, unknown>

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown, max = MAX_STRING): v is string => typeof v === 'string' && v.length <= max

const int = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max

const bool = (v: unknown): v is boolean => typeof v === 'boolean'

const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): v is T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v)

const hex64 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)

const id = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-zA-Z_-]{1,64}$/.test(v)

const TYPES: readonly MessageType[] = [
  'HELLO',
  'TRANSFER_OFFER',
  'TRANSFER_ACCEPT',
  'TRANSFER_REJECT',
  'TRANSFER_PAUSE',
  'TRANSFER_RESUME',
  'TRANSFER_FLOW',
  'TRANSFER_CHECKPOINT',
  'TRANSFER_CANCEL',
  'TRANSFER_COMPLETE',
  'TRANSFER_VERIFY',
  'TRANSFER_ERROR',
  'SESSION_APPROVE',
  'SESSION_END',
  'PATH_NOTE',
  'TEXT_SHARE'
]

export function parseControl(raw: unknown): ParseResult {
  let value = raw

  // Trystero hands JSON payloads back as objects, but tolerate a string too.
  if (typeof value === 'string') {
    if (value.length > LIMITS.maxControlMessageBytes) return {ok: false, reason: 'too-large'}
    try {
      value = JSON.parse(value)
    } catch {
      return {ok: false, reason: 'malformed'}
    }
  }

  if (!isRec(value)) return {ok: false, reason: 'malformed'}
  if (!int(value.v, 0, 1000)) return {ok: false, reason: 'malformed'}
  if (value.v < MIN_COMPATIBLE_VERSION || value.v > PROTOCOL_VERSION) {
    return {ok: false, reason: 'incompatible-version'}
  }
  if (!oneOf(value.t, TYPES)) return {ok: false, reason: 'malformed'}

  return validateBody(value) ? {ok: true, message: value as unknown as ControlMessage} : {ok: false, reason: 'malformed'}
}

function validateBody(m: Rec): boolean {
  switch (m.t) {
    case 'HELLO':
      return (
        id(m.sessionId) &&
        (m.deviceId === undefined || id(m.deviceId)) &&
        str(m.deviceName, 128) &&
        str(m.deviceKind, 32) &&
        int(m.maxFileSize, 0, Number.MAX_SAFE_INTEGER) &&
        bool(m.supportsResume)
      )

    case 'TRANSFER_OFFER':
      return (
        id(m.transferId) &&
        int(m.seq, 0, 65535) &&
        // Length only; sanitizeFilename does the character work at use sites.
        str(m.name, LIMITS.maxFilenameLength * 4) &&
        int(m.size, 0, Number.MAX_SAFE_INTEGER) &&
        str(m.mimeType, 255) &&
        int(m.lastModified, 0, Number.MAX_SAFE_INTEGER) &&
        int(m.chunkSize, MIN_CHUNK_SIZE, MAX_CHUNK_SIZE) &&
        int(m.totalChunks, 0, MAX_TOTAL_CHUNKS) &&
        str(m.hashAlgorithm, 64) &&
        (m.relPath === undefined || str(m.relPath, 1024)) &&
        (m.batchId === undefined || id(m.batchId)) &&
        // The chunk count must actually describe the declared size.
        m.totalChunks === Math.ceil(m.size / m.chunkSize)
      )

    case 'TRANSFER_ACCEPT':
      return id(m.transferId) && int(m.fromChunk, 0, MAX_TOTAL_CHUNKS)

    case 'TRANSFER_REJECT':
      return id(m.transferId) && oneOf(m.reason, ['declined', 'too-large', 'no-storage', 'busy'] as const)

    case 'TRANSFER_PAUSE':
      return id(m.transferId)

    case 'TRANSFER_FLOW':
      return id(m.transferId) && bool(m.paused)

    case 'TRANSFER_RESUME':
      return (
        id(m.transferId) &&
        isRec(m.identity) &&
        int(m.identity.size, 0, Number.MAX_SAFE_INTEGER) &&
        int(m.identity.lastModified, 0, Number.MAX_SAFE_INTEGER) &&
        int(m.identity.chunkSize, MIN_CHUNK_SIZE, MAX_CHUNK_SIZE)
      )

    case 'TRANSFER_CHECKPOINT':
      return (
        id(m.transferId) &&
        int(m.chunks, 0, MAX_TOTAL_CHUNKS) &&
        int(m.bytes, 0, Number.MAX_SAFE_INTEGER)
      )

    case 'TRANSFER_CANCEL':
      return id(m.transferId) && oneOf(m.reason, ['user', 'error', 'storage', 'shutdown'] as const)

    case 'TRANSFER_COMPLETE':
      return id(m.transferId) && hex64(m.contentHash)

    case 'TRANSFER_VERIFY':
      return id(m.transferId) && bool(m.ok) && hex64(m.contentHash)

    case 'TRANSFER_ERROR':
      return (
        (m.transferId === undefined || id(m.transferId)) &&
        str(m.code, 64) &&
        (m.detail === undefined || str(m.detail, 512))
      )

    case 'SESSION_APPROVE':
      return bool(m.approved)

    case 'SESSION_END':
      return oneOf(m.reason, ['user', 'expired', 'blocked', 'full'] as const)

    case 'PATH_NOTE':
      return oneOf(m.kind, PATH_KINDS)

    case 'TEXT_SHARE':
      return id(m.id) && str(m.text, LIMITS.maxTextLength)

    default:
      return false
  }
}

/**
 * Token bucket guarding against a peer flooding the control channel (§75.2).
 */
export class MessageRateLimiter {
  #tokens: number
  #lastRefill = performance.now()
  #perSecond: number
  #burst: number

  constructor(perSecond: number = LIMITS.maxControlMessagesPerSecond) {
    this.#perSecond = perSecond
    this.#burst = perSecond * 2
    this.#tokens = this.#burst
  }

  allow(now = performance.now()): boolean {
    const elapsed = (now - this.#lastRefill) / 1000
    this.#lastRefill = now
    this.#tokens = Math.min(this.#burst, this.#tokens + elapsed * this.#perSecond)
    if (this.#tokens < 1) return false
    this.#tokens -= 1
    return true
  }
}
