/**
 * Minimal typed event emitter. The core layer stays framework-free; the UI
 * subscribes to these events rather than reaching into transport internals.
 */
export type Listener<T> = (payload: T) => void

export class Emitter<Events extends Record<string, unknown>> {
  #handlers = new Map<keyof Events, Set<Listener<never>>>()

  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    let set = this.#handlers.get(event)
    if (!set) {
      set = new Set()
      this.#handlers.set(event, set)
    }
    set.add(fn as Listener<never>)
    return () => {
      set.delete(fn as Listener<never>)
    }
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.#handlers.get(event)
    if (!set) return
    // Copy so a listener that unsubscribes mid-dispatch cannot skip a sibling.
    for (const fn of [...set]) {
      try {
        ;(fn as Listener<Events[K]>)(payload)
      } catch (err) {
        console.error(`listener for "${String(event)}" threw`, err)
      }
    }
  }

  clear(): void {
    this.#handlers.clear()
  }
}
