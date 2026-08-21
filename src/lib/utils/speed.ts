/**
 * Smoothed throughput (spec §55): a rolling window rather than the
 * instantaneous rate of the last chunk, which is far too noisy to display.
 */
export class SpeedMeter {
  #samples: {at: number; bytes: number}[] = []
  #total = 0
  #windowMs: number
  #minSamples: number

  /**
   * The window is a trade between a steady number and a current one.
   *
   * At 5s it lagged badly out of the slow start every transfer begins with:
   * measured against real arrivals, the readout climbed at ~6.5 MB/s per
   * second while the link was already doing 27, so it under-reported for
   * several seconds after the transfer had recovered. Halving it doubles the
   * rate of convergence to ~12 MB/s per second. Two samples rather than three
   * because a 2.5s window during a slow start may not hold three; `rate()`
   * still refuses to answer under 250ms of elapsed time, which is what keeps
   * a single fast pair from reading as a spike.
   */
  constructor(windowMs = 2500, minSamples = 2) {
    this.#windowMs = windowMs
    this.#minSamples = minSamples
  }

  record(bytes: number, now = performance.now()): void {
    if (bytes <= 0) return
    this.#samples.push({at: now, bytes})
    this.#total += bytes
    this.#prune(now)
  }

  /** Bytes per second, or null while there isn't enough data to be meaningful. */
  rate(now = performance.now()): number | null {
    this.#prune(now)
    if (this.#samples.length < this.#minSamples) return null

    const first = this.#samples[0]
    if (!first) return null
    // Measure from the first sample in the window, not from `now - windowMs`:
    // a transfer that just started would otherwise be averaged against idle time.
    const elapsed = now - first.at
    if (elapsed < 250) return null

    // The first sample's bytes landed *before* the window opened.
    const bytes = this.#total - first.bytes
    return bytes > 0 ? (bytes / elapsed) * 1000 : null
  }

  /** Seconds remaining, or null when it cannot be estimated yet. */
  eta(remainingBytes: number, now = performance.now()): number | null {
    if (remainingBytes <= 0) return 0
    const rate = this.rate(now)
    if (rate === null || rate <= 0) return null
    return remainingBytes / rate
  }

  /** Called on pause/reconnect so the stall does not poison the average. */
  reset(): void {
    this.#samples = []
    this.#total = 0
  }

  #prune(now: number): void {
    const cutoff = now - this.#windowMs
    while (this.#samples.length > 2 && (this.#samples[0]?.at ?? 0) < cutoff) {
      this.#total -= this.#samples.shift()?.bytes ?? 0
    }
  }
}
