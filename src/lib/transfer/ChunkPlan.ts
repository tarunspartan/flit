import type {ChunkRange} from '../protocol/messages.ts'

/**
 * The chunks a sender still owes the receiver, walked in order.
 *
 * Built from the receiver's own account of what it lacks, so a resume sends the
 * gaps and nothing else. The alternative — rewind to the first missing chunk
 * and resend everything after it — turned one lost chunk near the start of a
 * large file into resending almost the whole file.
 */
export class ChunkPlan {
  readonly #ranges: readonly ChunkRange[]
  #range = 0
  #next: number

  private constructor(ranges: readonly ChunkRange[]) {
    this.#ranges = ranges
    this.#next = ranges[0]?.[0] ?? 0
  }

  static none(): ChunkPlan {
    return new ChunkPlan([])
  }

  /**
   * What an ACCEPT asks for. `missing` wins when present; without it — an
   * older receiver — everything from `fromChunk` to the end. Chunks for which
   * `skip` is true are left out.
   */
  static fromAccept(
    fromChunk: number,
    totalChunks: number,
    missing?: ChunkRange[],
    skip?: (index: number) => boolean
  ): ChunkPlan {
    const requested = missing ?? [[fromChunk, totalChunks]]
    const ranges: ChunkRange[] = []
    for (const [start, end] of requested) {
      const from = Math.max(0, start)
      const to = Math.min(totalChunks, end)
      if (!skip) {
        if (from < to) ranges.push([from, to])
        continue
      }
      let open = -1
      for (let i = from; i < to; i++) {
        if (skip(i)) {
          if (open !== -1) ranges.push([open, i])
          open = -1
        } else if (open === -1) {
          open = i
        }
      }
      if (open !== -1) ranges.push([open, to])
    }
    return new ChunkPlan(ranges)
  }

  static of(ranges: ChunkRange[]): ChunkPlan {
    return new ChunkPlan(ranges.filter(([start, end]) => start < end))
  }

  /** The next chunk to send, or null once the plan is spent. */
  take(): number | null {
    const range = this.#ranges[this.#range]
    if (!range) return null
    const index = this.#next
    this.#next++
    if (this.#next >= range[1]) {
      this.#range++
      this.#next = this.#ranges[this.#range]?.[0] ?? 0
    }
    return index
  }

  get done(): boolean {
    return this.#range >= this.#ranges.length
  }

  /** Bytes the whole plan covers, which is what the receiver is still missing. */
  bytes(fileSize: number, chunkSize: number): number {
    let total = 0
    for (const [start, end] of this.#ranges) {
      total += Math.min(fileSize, end * chunkSize) - Math.min(fileSize, start * chunkSize)
    }
    return total
  }
}
