/**
 * Sender-side backpressure (spec §13).
 *
 * The transport already waits for the data channel to drain inside a send, so
 * awaiting one send is enough to avoid unbounded buffering there. This adds the
 * other half: a bounded number of *concurrent* chunk sends — each one a file
 * read, a hash and a send — so the pipeline stays full while sender memory stays
 * capped at `maxInFlight × chunkSize` regardless of file size.
 */
export class FlowController {
  #maxInFlight: number
  #inFlight = 0
  #waiters: (() => void)[] = []
  #idle: (() => void)[] = []

  constructor(maxInFlight: number) {
    this.#maxInFlight = Math.max(1, maxInFlight)
  }

  get inFlight(): number {
    return this.#inFlight
  }

  acquire(): Promise<void> {
    if (this.#inFlight < this.#maxInFlight) {
      this.#inFlight++
      return Promise.resolve()
    }
    return new Promise<void>(resolve => {
      this.#waiters.push(() => {
        this.#inFlight++
        resolve()
      })
    })
  }

  release(): void {
    this.#inFlight = Math.max(0, this.#inFlight - 1)
    const next = this.#waiters.shift()
    if (next) {
      next()
      return
    }
    if (this.#inFlight === 0) {
      const idle = this.#idle
      this.#idle = []
      for (const resolve of idle) resolve()
    }
  }

  /** Resolves once every outstanding permit has been released. */
  drain(): Promise<void> {
    if (this.#inFlight === 0) return Promise.resolve()
    return new Promise(resolve => this.#idle.push(resolve))
  }

  /** Wakes everyone up so a cancelled transfer's pump loop can exit. */
  abort(): void {
    const waiters = this.#waiters
    this.#waiters = []
    for (const waiter of waiters) waiter()
  }
}
