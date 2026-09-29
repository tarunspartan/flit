/**
 * Integrity verification (spec §15).
 *
 * Web Crypto has no streaming digest, and buffering a 5 GB file to hash it
 * would defeat the whole streaming design. So the content hash is a chunk tree:
 * SHA-256 of every chunk, then SHA-256 over those digests in index order,
 * domain-separated by the file's size and chunking.
 *
 * That is incremental (hash as bytes flow), resumable (digests survive a
 * reconnect), and uses only native crypto, so it does not become the
 * throughput bottleneck.
 */
import type {Bytes} from '../core/bytes.ts'
import {HASH_ALGORITHM, type ChunkRange} from '../protocol/messages.ts'

export const DIGEST_BYTES = 32

export async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data))
}

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

export class ChunkTreeHasher {
  readonly totalChunks: number
  readonly chunkSize: number
  readonly size: number

  /** Flat digest table: 32 bytes per chunk, allocated on first use. */
  #digests: Bytes | null = null
  #present: Uint8Array
  #count = 0
  /** The finished root, until a digest changes. */
  #root: Promise<string> | null = null
  /** Digests being computed right now, by chunk. */
  #hashing = new Map<number, Promise<void>>()

  constructor(size: number, chunkSize: number, totalChunks: number) {
    this.size = size
    this.chunkSize = chunkSize
    this.totalChunks = totalChunks
    this.#present = new Uint8Array(totalChunks)
  }

  get algorithm(): string {
    return HASH_ALGORITHM
  }

  get complete(): boolean {
    return this.#count === this.totalChunks
  }

  has(index: number): boolean {
    return this.#present[index] === 1
  }

  async add(index: number, payload: Bytes): Promise<void> {
    this.setDigest(index, await sha256(payload))
  }

  /**
   * Hashes a chunk unless its digest is known or already being computed.
   *
   * For a hasher shared by several transfers of one file: two devices
   * downloading it at once would otherwise both hash every chunk, because each
   * checks `has()` while the other's digest is still in flight.
   */
  ensure(index: number, payload: Bytes): Promise<void> {
    if (this.has(index)) return Promise.resolve()
    let pending = this.#hashing.get(index)
    if (!pending) {
      pending = this.add(index, payload).finally(() => this.#hashing.delete(index))
      this.#hashing.set(index, pending)
    }
    return pending
  }

  setDigest(index: number, digest: Bytes): void {
    if (index < 0 || index >= this.totalChunks) return
    if (digest.byteLength !== DIGEST_BYTES) return

    this.#digests ??= new Uint8Array(this.totalChunks * DIGEST_BYTES)
    this.#digests.set(digest, index * DIGEST_BYTES)
    this.#root = null
    if (this.#present[index] !== 1) {
      this.#present[index] = 1
      this.#count++
    }
  }

  getDigest(index: number): Bytes | null {
    if (!this.#digests || this.#present[index] !== 1) return null
    return this.#digests.subarray(index * DIGEST_BYTES, (index + 1) * DIGEST_BYTES)
  }

  /**
   * Highest N such that chunks 0..N-1 are all present. This is what the
   * receiver may safely checkpoint and what a resume restarts from.
   */
  contiguousCount(from = 0): number {
    let n = from
    while (n < this.totalChunks && this.#present[n] === 1) n++
    return n
  }

  /**
   * The chunks still absent, as ascending half-open ranges.
   *
   * `skip` excludes chunks that are on their way in but not yet recorded, so
   * asking for the gaps never re-requests something already being written. At
   * most `maxRanges` come back: past that the last one is left open to the end
   * of the file, which may re-request a few present chunks but can never leave
   * a missing one out.
   */
  missingRanges(maxRanges: number, skip?: (index: number) => boolean): ChunkRange[] {
    const ranges: ChunkRange[] = []
    let start = -1
    for (let i = 0; i < this.totalChunks; i++) {
      const needed = this.#present[i] !== 1 && !skip?.(i)
      if (needed && start === -1) {
        start = i
        if (ranges.length === maxRanges - 1) {
          ranges.push([start, this.totalChunks])
          return ranges
        }
      } else if (!needed && start !== -1) {
        ranges.push([start, i])
        start = -1
      }
    }
    if (start !== -1) ranges.push([start, this.totalChunks])
    return ranges
  }

  /**
   * The content hash. Computed once and reused: a room of eight devices shares
   * one hasher per file, and a re-announced completion asks for it again.
   */
  root(): Promise<string> {
    if (!this.complete) {
      return Promise.reject(
        new Error(`cannot hash: ${this.#count}/${this.totalChunks} chunks present`)
      )
    }
    this.#root ??= this.#computeRoot().catch(err => {
      this.#root = null
      throw err
    })
    return this.#root
  }

  async #computeRoot(): Promise<string> {
    // Bind the structure into the hash so two different chunkings of the same
    // bytes cannot collide, and an empty file still gets a well-defined value.
    const prefix = new TextEncoder().encode(
      `${HASH_ALGORITHM}|${this.size}|${this.chunkSize}|${this.totalChunks}|`
    )
    const digests = this.#digests ?? new Uint8Array(0)
    const buffer = new Uint8Array(prefix.byteLength + this.totalChunks * DIGEST_BYTES)
    buffer.set(prefix, 0)
    buffer.set(digests.subarray(0, this.totalChunks * DIGEST_BYTES), prefix.byteLength)
    return toHex(await sha256(buffer))
  }
}
