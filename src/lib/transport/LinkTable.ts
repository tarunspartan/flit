import type {PeerId} from './Transport.ts'

/**
 * Every live connection to each device, and which one is in use.
 *
 * Signaling runs over two independent networks, so one device can be reached
 * twice — a connection introduced over each. They are still one device: the
 * first connection is the one sent on, later ones wait on standby, and losing
 * the one in use hands over to a standby rather than losing the device.
 *
 * Generic and free of WebRTC, so the bookkeeping is tested on its own.
 */
export class LinkTable<L> {
  #links = new Map<PeerId, L[]>()

  /** Records a connection. 'arrived' when it is the device's first. */
  add(peerId: PeerId, link: L): 'arrived' | 'standby' {
    const list = this.#links.get(peerId)
    if (!list) {
      this.#links.set(peerId, [link])
      return 'arrived'
    }
    if (!list.includes(link)) list.push(link)
    return 'standby'
  }

  /**
   * Forgets a connection, and says what that means for the device: 'departed'
   * when it was the last one, 'switched' when the one in use went and a
   * standby took over, 'none' when nothing anyone can see has changed —
   * including a connection already forgotten, so a death is only ever
   * reported once however many times it is noticed.
   */
  remove(peerId: PeerId, link: L): 'departed' | 'switched' | 'none' {
    const list = this.#links.get(peerId)
    const at = list ? list.indexOf(link) : -1
    if (!list || at === -1) return 'none'
    list.splice(at, 1)
    if (list.length === 0) {
      this.#links.delete(peerId)
      return 'departed'
    }
    return at === 0 ? 'switched' : 'none'
  }

  /** The connection to send on. */
  active(peerId: PeerId): L | undefined {
    return this.#links.get(peerId)?.[0]
  }

  linksOf(peerId: PeerId): readonly L[] {
    return this.#links.get(peerId) ?? []
  }

  peers(): PeerId[] {
    return [...this.#links.keys()]
  }

  *entries(): Iterable<[PeerId, L]> {
    for (const [peerId, list] of this.#links) for (const link of [...list]) yield [peerId, link]
  }

  clear(): void {
    this.#links.clear()
  }
}
