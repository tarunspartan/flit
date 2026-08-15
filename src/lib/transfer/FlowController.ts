/**
 * Sender-side backpressure (spec §13).
 *
 * Trystero already waits on `bufferedamountlow` inside a single send, so
 * awaiting one send is enough to avoid unbounded DataChannel buffering. This
 * adds the other half: a bounded number of *concurrent* sends, so the pipeline
 * stays full (good throughput) while sender memory stays capped at
 * `maxInFlight × chunkSize` regardless of file size.
 */
export class FlowController {
  #maxInFlight: number
  #inFlight = 0
  #waiters: (() => void)[] = []

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
    if (next) next()
  }

  /** Resolves once every outstanding permit has been released. */
  async drain(): Promise<void> {
    while (this.#inFlight > 0) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  /** Wakes everyone up so a cancelled transfer's pump loop can exit. */
  abort(): void {
    const waiters = this.#waiters
    this.#waiters = []
    for (const waiter of waiters) waiter()
  }
}
