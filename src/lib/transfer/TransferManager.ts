import {LIMITS} from '../core/config.ts'
import {Emitter} from '../core/events.ts'
import {AppError, friendly} from '../core/errors.ts'
import {randomId} from '../core/ids.ts'
import type {ChunkFrame} from '../protocol/frame.ts'
import type {ControlMessage, TransferOffer} from '../protocol/messages.ts'
import type {StoragePreferences} from '../storage/index.ts'
import {uniqueFilename} from '../utils/filename.ts'
import type {PeerLink} from './PeerLink.ts'
import {ReceiveTransfer} from './ReceiveTransfer.ts'
import {SendTransfer} from './SendTransfer.ts'
import {isActive, isTerminal, type SharedFileView, type TransferView} from './states.ts'

const STALL_TICK_MS = 5000

export interface TransferManagerEvents extends Record<string, unknown> {
  update: void
  /** Something the user should be told about that isn't tied to a transfer. */
  notice: {title: string; message: string; tone: 'info' | 'error'}
}

interface SharedFile {
  id: string
  file: File
  relPath: string | undefined
  /** Shared by everything dropped in the same action. */
  batchId: string
  addedAt: number
}

/**
 * Owns shared files, the per-device send queues, and the transfer state machine.
 *
 * A dropped file is *shared with the room*, not sent to one device: it is
 * offered to everyone currently connected and re-offered to anyone who joins
 * later, so you can drop files first and let devices arrive afterwards.
 */
export class TransferManager {
  #linkFor: (peerId: string) => PeerLink
  #prefs: StoragePreferences
  #emitter = new Emitter<TransferManagerEvents>()

  #shared: SharedFile[] = []
  #sends = new Map<string, SendTransfer>()
  /** Keyed `peerId|transferId` — ids are only unique within one peer. */
  #receives = new Map<string, ReceiveTransfer>()
  /** Keyed `peerId|seq` for routing binary frames. */
  #receiveBySeq = new Map<string, ReceiveTransfer>()
  /** Which shared files each peer has already been offered. */
  #offered = new Map<string, Set<string>>()
  #peers = new Map<string, string>()
  #usedNames = new Set<string>()
  /** Downloads the user has approved that are waiting their turn. */
  #queuedAccepts = new Set<string>()
  /**
   * Who holds the download slot per device, claimed synchronously.
   *
   * accept() is async — it opens storage before reaching TRANSFERRING — so a
   * loop that accepts five files in one tick would find the slot idle five
   * times and start all five. The claim closes that gap.
   */
  #claimed = new Map<string, string>()
  #nextSeq = 1
  #watchdog: ReturnType<typeof setInterval> | null = null
  /** When the watchdog last ran, so a late tick can be recognised as a freeze. */
  #lastTick = Date.now()

  constructor(linkFor: (peerId: string) => PeerLink, prefs: StoragePreferences) {
    this.#linkFor = linkFor
    this.#prefs = prefs
    this.#watchdog = setInterval(() => this.#tick(), STALL_TICK_MS)
  }

  on = <K extends keyof TransferManagerEvents>(
    event: K,
    listener: (payload: TransferManagerEvents[K]) => void
  ): (() => void) => this.#emitter.on(event, listener)

  setPreferences(prefs: StoragePreferences): void {
    this.#prefs = prefs
  }

  // ------------------------------------------------------------ shared files

  /** Adds files to the room. Anything over a limit is reported, not dropped silently. */
  addFiles(files: File[]): void {
    if (this.#shared.length + files.length > LIMITS.maxFilesPerSession) {
      this.#notice(new AppError('too-many-files'))
      return
    }

    // One id for this drop, so the far side can show "5 files" as a batch
    // instead of five unrelated cards — and so a device joining later groups
    // them the same way rather than by when it happened to hear about them.
    const batchId = randomId(8)
    let added = 0
    for (const file of files) {
      if (file.size > LIMITS.maxFileSize) {
        this.#emitter.emit('notice', {
          title: `"${file.name}" is too large`,
          message: friendly(new AppError('too-large')).message,
          tone: 'error'
        })
        continue
      }
      this.#shared.push({
        id: randomId(8),
        file,
        relPath: relativePathOf(file),
        batchId,
        addedAt: Date.now()
      })
      added++
    }

    if (added === 0) return
    for (const peerId of this.#peers.keys()) this.#offerShared(peerId)
    this.#changed()
  }

  /** Stops sharing a file and cancels any transfer of it still in flight. */
  unshare(sharedId: string): void {
    this.#shared = this.#shared.filter(entry => entry.id !== sharedId)
    for (const transfer of this.#sends.values()) {
      if (transfer.sharedId === sharedId) transfer.cancel()
    }
    for (const offered of this.#offered.values()) offered.delete(sharedId)
    this.#changed()
  }

  #offerShared(peerId: string): void {
    let offered = this.#offered.get(peerId)
    if (!offered) {
      offered = new Set()
      this.#offered.set(peerId, offered)
    }

    for (const entry of this.#shared) {
      if (offered.has(entry.id)) continue
      offered.add(entry.id)
      const transfer = new SendTransfer({
        id: randomId(8),
        seq: this.#nextSeq++ & 0xffff,
        peerId,
        peerName: this.#peers.get(peerId) ?? 'Device',
        file: entry.file,
        ...(entry.relPath ? {relPath: entry.relPath} : {}),
        batchId: entry.batchId,
        link: this.#linkFor(peerId),
        onChange: () => this.#changed()
      })
      transfer.sharedId = entry.id
      this.#sends.set(transfer.id, transfer)
    }

    this.#pumpQueue(peerId)
  }

  /** One active transfer per device, so each gets the full pipe in turn. */
  /**
   * Offers every shared file to a device, rather than one at a time.
   *
   * An offer is metadata, not bytes. Holding the rest back until the first
   * transfer finished meant a device could see only the first of the files
   * shared with it, with nothing on screen to say the others existed — and if
   * that first file was never accepted, the rest never appeared at all.
   *
   * Bytes are still driven by what the receiver accepts; the sender no longer
   * decides for it which file it is allowed to know about.
   */
  #pumpQueue(peerId: string): void {
    const queue = [...this.#sends.values()].filter(transfer => transfer.peerId === peerId)
    void this.#offerQueued(queue)
  }

  async #offerQueued(queue: SendTransfer[]): Promise<void> {
    for (const transfer of queue) {
      // start() ignores anything already past QUEUED, so overlapping calls from
      // the several places that pump the queue cannot double-send an offer.
      if (transfer.state !== 'QUEUED') continue
      // Awaited one at a time rather than fired together: a large drop would
      // otherwise put hundreds of offers on the wire at once and trip the
      // receiver's control-message rate limit, and a dropped offer is a file
      // the other device never hears about.
      await transfer.start()
    }
  }

  // --------------------------------------------------------------- peers

  peerReady(peerId: string, peerName: string): void {
    this.#peers.set(peerId, peerName)
    for (const transfer of this.#sends.values()) {
      if (transfer.peerId === peerId) transfer.peerName = peerName
    }
    for (const transfer of this.#receives.values()) {
      if (transfer.peerId === peerId) transfer.peerName = peerName
    }
    this.#offerShared(peerId)
    this.#changed()
  }

  peerLost(peerId: string): void {
    for (const transfer of this.#sends.values()) {
      if (transfer.peerId === peerId) transfer.onPeerLost()
    }
    for (const transfer of this.#receives.values()) {
      if (transfer.peerId === peerId) transfer.onPeerLost()
    }
    this.#changed()
  }

  peerRestored(peerId: string): void {
    for (const transfer of this.#sends.values()) {
      if (transfer.peerId === peerId) transfer.onPeerRestored()
    }
    for (const transfer of this.#receives.values()) {
      if (transfer.peerId === peerId) transfer.onPeerRestored()
    }
    this.#pumpQueue(peerId)
    this.#changed()
  }

  /** The device is gone for good: stop its transfers and forget what it was offered. */
  peerRemoved(peerId: string): void {
    for (const transfer of this.#sends.values()) {
      if (transfer.peerId === peerId) transfer.cancel(false)
    }
    for (const [key, transfer] of this.#receives) {
      if (transfer.peerId !== peerId) continue
      transfer.cancel(false)
      this.#receives.delete(key)
      this.#receiveBySeq.delete(seqKey(peerId, transfer.seq))
    }
    this.#peers.delete(peerId)
    this.#offered.delete(peerId)
    this.#changed()
  }

  // ----------------------------------------------------------------- inbound

  handleControl(peerId: string, msg: ControlMessage): void {
    if (msg.t === 'TRANSFER_OFFER') {
      this.#onOffer(peerId, msg)
      return
    }
    if (!('transferId' in msg) || msg.transferId === undefined) return

    const send = this.#sends.get(msg.transferId)
    if (send && send.peerId === peerId) {
      send.handleMessage(msg)
      this.#pumpQueue(peerId)
      this.#changed()
      return
    }

    const receive = this.#receives.get(key(peerId, msg.transferId))
    if (receive) {
      receive.handleMessage(msg)
      this.#changed()
    }
  }

  handleChunk(peerId: string, frame: ChunkFrame): void {
    // Missing means a cancelled transfer's chunk arriving late.
    this.#receiveBySeq.get(seqKey(peerId, frame.seq))?.handleChunk(frame.index, frame.payload)
  }

  #onOffer(peerId: string, offer: TransferOffer): void {
    const id = key(peerId, offer.transferId)
    if (this.#receives.has(id)) return // Duplicate offer.

    const transfer = new ReceiveTransfer({
      offer,
      peerId,
      peerName: this.#peers.get(peerId) ?? 'Device',
      link: this.#linkFor(peerId),
      onChange: () => {
        // The running download finishing is what releases the next one.
        this.#pumpDownloads(peerId)
        this.#changed()
      },
      storagePrefs: this.#prefs,
      reserveName: name => {
        const unique = uniqueFilename(name, this.#usedNames)
        this.#usedNames.add(unique)
        return unique
      }
    })

    this.#receives.set(id, transfer)
    this.#receiveBySeq.set(seqKey(peerId, transfer.seq), transfer)
    void transfer.prepare()
    this.#changed()
  }

  // ------------------------------------------------------------- user actions

  /**
   * Starts a download, or puts it in line behind the one already running.
   *
   * One at a time per device, because five downloads sharing one connection all
   * crawl and none of them finishes: serially, the first file is usable while
   * the rest are still arriving, and an interruption costs one part-file rather
   * than five.
   */
  accept(id: string): void {
    const transfer = this.#findReceive(id)
    if (!transfer || transfer.state !== 'WAITING_FOR_ACCEPT') return

    if (this.#downloading(transfer.peerId)) {
      this.#queuedAccepts.add(transfer.id)
      this.#pumpDownloads(transfer.peerId)
      return
    }
    this.#beginDownload(transfer)
  }

  /**
   * Starts a download in the claimed slot, and hands the slot back if it never
   * actually began.
   *
   * Dismissing the save dialog leaves the transfer in WAITING_FOR_ACCEPT, which
   * is not terminal — so #downloading would go on seeing the claim as live and
   * every queued file would wait behind a download that never started.
   */
  #beginDownload(transfer: ReceiveTransfer): void {
    this.#claimed.set(transfer.peerId, transfer.id)
    void transfer.accept().finally(() => {
      if (transfer.state !== 'WAITING_FOR_ACCEPT') return
      if (this.#claimed.get(transfer.peerId) === transfer.id) {
        this.#claimed.delete(transfer.peerId)
      }
      this.#pumpDownloads(transfer.peerId)
    })
  }

  /**
   * Takes a download back out of the queue, leaving the offer intact.
   *
   * Deliberately not a cancel: cancelling is terminal, so a queued file that
   * was cancelled could never be downloaded afterwards. Since a queued transfer
   * never left WAITING_FOR_ACCEPT — only the accept was held back — dropping it
   * from the queue puts the Download button back exactly as it was. Accept five,
   * change your mind, then take just the two you wanted.
   */
  unqueue(id: string): void {
    const transfer = this.#findReceive(id)
    if (!transfer || !this.#queuedAccepts.has(transfer.id)) return
    this.#queuedAccepts.delete(transfer.id)
    transfer.queuePosition = null
    this.#pumpDownloads(transfer.peerId)
    this.#changed()
  }

  /** True while a download from this device is occupying the slot. */
  #downloading(peerId: string): boolean {
    const claimed = this.#claimed.get(peerId)
    if (claimed !== undefined) {
      const holder = this.#findReceive(claimed)
      if (holder && !isTerminal(holder.state)) return true
      this.#claimed.delete(peerId)
    }

    for (const transfer of this.#receives.values()) {
      if (transfer.peerId !== peerId) continue
      if (isActive(transfer.state) || transfer.state === 'VERIFYING') return true
    }
    return false
  }

  /**
   * Numbers the waiting downloads and lets the next one go when the slot frees.
   * Called on every receive-side change, so finishing, failing or cancelling the
   * running transfer all release the queue.
   */
  #pumpDownloads(peerId: string): void {
    const waiting = [...this.#receives.values()].filter(
      transfer => transfer.peerId === peerId && this.#queuedAccepts.has(transfer.id)
    )

    // Anything that left WAITING_FOR_ACCEPT — cancelled, or already started —
    // is no longer queued.
    for (const transfer of waiting) {
      if (transfer.state !== 'WAITING_FOR_ACCEPT') {
        this.#queuedAccepts.delete(transfer.id)
        transfer.queuePosition = null
      }
    }

    const queue = waiting.filter(transfer => this.#queuedAccepts.has(transfer.id))
    let position = 0
    for (const transfer of queue) transfer.queuePosition = ++position

    if (this.#downloading(peerId)) return
    const next = queue[0]
    if (!next) return
    this.#queuedAccepts.delete(next.id)
    next.queuePosition = null
    this.#beginDownload(next)
  }

  reject(id: string): void {
    void this.#findReceive(id)?.reject()
  }

  pause(id: string): void {
    this.#sends.get(id)?.pause()
    this.#findReceive(id)?.pause()
  }

  resume(id: string): void {
    this.#sends.get(id)?.resume()
    this.#findReceive(id)?.resume()
  }

  cancel(id: string): void {
    const send = this.#sends.get(id)
    if (send) {
      send.cancel()
      this.#pumpQueue(send.peerId)
    }
    this.#findReceive(id)?.cancel()
    this.#changed()
  }

  cancelAll(): void {
    for (const transfer of this.#sends.values()) transfer.cancel()
    for (const transfer of this.#receives.values()) transfer.cancel()
    this.#changed()
  }

  saveAgain(id: string): void {
    this.#findReceive(id)?.saveAgain()
  }

  /** Retries in place, keeping the transfer bound to the same device. */
  retry(id: string): void {
    const previous = this.#sends.get(id)
    if (!previous) return

    const replacement = new SendTransfer({
      id: randomId(8),
      seq: this.#nextSeq++ & 0xffff,
      peerId: previous.peerId,
      peerName: previous.peerName,
      file: previous.file,
      ...(previous.relPath ? {relPath: previous.relPath} : {}),
      link: this.#linkFor(previous.peerId),
      onChange: () => this.#changed()
    })
    replacement.sharedId = previous.sharedId

    this.#sends.delete(id)
    this.#sends.set(replacement.id, replacement)
    this.#pumpQueue(previous.peerId)
    this.#changed()
  }

  // ---------------------------------------------------------------- accessors

  /** Dropped files, each with one row per device it was offered to. */
  sharedFiles(): SharedFileView[] {
    return this.#shared.map(entry => ({
      id: entry.id,
      name: entry.file.name,
      size: entry.file.size,
      addedAt: entry.addedAt,
      batchId: entry.batchId,
      transfers: [...this.#sends.values()]
        .filter(transfer => transfer.sharedId === entry.id)
        .map(transfer => transfer.view())
    }))
  }

  /**
   * Files other devices are sending to this one, in the order they were
   * offered — Map iteration is insertion order, which is arrival order.
   *
   * Deliberately not sorted by startedAt: an unstarted transfer reads as 0
   * there, so the moment one file in a batch was accepted it sorted below the
   * four that had not started, and a batch reordered itself as you used it.
   */
  incoming(): TransferView[] {
    return [...this.#receives.values()].map(transfer => transfer.view())
  }

  /**
   * Read straight off `state` rather than through `view()`. This is called on
   * every render of the app — it drives the unload guard and the wake lock —
   * and `view()` builds a fresh object per transfer, so the old form allocated
   * one object per transfer several times a second to look at one field.
   */
  hasActiveTransfers(): boolean {
    for (const transfer of this.#sends.values()) if (!isTerminal(transfer.state)) return true
    for (const transfer of this.#receives.values()) if (!isTerminal(transfer.state)) return true
    return false
  }

  /** Cancels everything in flight and clears history, for a fresh session. */
  reset(): void {
    this.stopAll()
    this.#sends.clear()
    this.#receives.clear()
    this.#receiveBySeq.clear()
    this.#shared = []
    this.#offered.clear()
    this.#peers.clear()
    this.#usedNames.clear()
    this.#nextSeq = 1
    this.#changed()
  }

  /** Stops in-flight work without discarding the visible history. */
  stopAll(): void {
    for (const transfer of this.#sends.values()) transfer.cancel(false)
    for (const transfer of this.#receives.values()) transfer.cancel(false)
    this.#changed()
  }

  dispose(): void {
    if (this.#watchdog !== null) clearInterval(this.#watchdog)
    this.#watchdog = null
    this.reset()
    this.#emitter.clear()
  }

  // ---------------------------------------------------------------- internals

  #findReceive(transferId: string): ReceiveTransfer | undefined {
    for (const transfer of this.#receives.values()) {
      if (transfer.id === transferId) return transfer
    }
    return undefined
  }

  #tick(): void {
    const now = Date.now()

    // A tick that lands far later than it was scheduled means this page was not
    // running between the two — a phone that locked, a laptop that slept, a tab
    // the OS froze. None of that is evidence about the transfer, so the missing
    // time is credited back before anything is judged on it. Detected from the
    // clock rather than from a visibility event, so laptop sleep and a frozen
    // background tab are both covered without touching the DOM.
    const overdue = now - this.#lastTick - STALL_TICK_MS
    this.#lastTick = now
    if (overdue > STALL_TICK_MS) {
      for (const transfer of this.#sends.values()) transfer.creditFrozen(overdue)
      for (const transfer of this.#receives.values()) transfer.creditFrozen(overdue)
    }

    for (const transfer of this.#sends.values()) transfer.checkStall(now)
    for (const transfer of this.#receives.values()) transfer.checkStall(now)
    for (const peerId of this.#peers.keys()) {
      this.#pumpQueue(peerId)
      // Belt and braces for the download queue. It is normally released by the
      // running transfer's own onChange, and a single missed callback used to
      // strand every queued file behind it until the user backed one out and
      // asked again. A queue that re-checks itself cannot get permanently stuck.
      this.#pumpDownloads(peerId)
    }
    this.#changed()
  }

  #changed(): void {
    this.#emitter.emit('update', undefined)
  }

  #notice(error: AppError): void {
    const {title, message} = friendly(error)
    this.#emitter.emit('notice', {title, message, tone: 'error'})
  }
}

const key = (peerId: string, transferId: string) => `${peerId}|${transferId}`
const seqKey = (peerId: string, seq: number) => `${peerId}|${seq}`

/** Set by the browser for files dropped as part of a directory. */
function relativePathOf(file: File): string | undefined {
  const path = (file as File & {webkitRelativePath?: string}).webkitRelativePath
  return path && path !== '' ? path : undefined
}
