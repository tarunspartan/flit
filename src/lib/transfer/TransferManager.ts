import {
  LIMITS,
  MAX_PARALLEL_SMALL_DOWNLOADS,
  OFFERS_PER_SECOND,
  SMALL_FILE_BYTES
} from '../core/config.ts'
import {Emitter} from '../core/events.ts'
import {AppError, friendly} from '../core/errors.ts'
import {randomId} from '../core/ids.ts'
import {ChunkTreeHasher} from '../integrity/hash.ts'
import {chunkSizeFor, type ChunkFrame} from '../protocol/frame.ts'
import type {ControlMessage, TransferOffer} from '../protocol/messages.ts'
import type {StoragePreferences} from '../storage/index.ts'
import {uniqueFilename} from '../utils/filename.ts'
import {keepIfSame} from '../utils/stable.ts'
import type {PeerLink} from './PeerLink.ts'
import {ReceiveTransfer} from './ReceiveTransfer.ts'
import {SendTransfer} from './SendTransfer.ts'
import {isMoving, type SharedFileView, type TransferView} from './states.ts'

/**
 * How often transfers are checked on: retries for unanswered messages, stall
 * detection, and the download queue. Well inside TIMEOUTS.retryMs so a retry
 * goes out close to when it falls due.
 */
const TICK_MS = 2500

/** Offers go out in small groups, spaced to keep within OFFERS_PER_SECOND. */
const OFFER_GROUP = 20

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
  /** The same sends, per shared file, in the order devices were offered it. */
  #sendsByShared = new Map<string, SendTransfer[]>()
  /** One set of chunk digests per shared file and chunk size. */
  #hashers = new Map<string, ChunkTreeHasher>()
  /** Last view handed out per shared file, so an unchanged one keeps its identity. */
  #sharedViews = new Map<string, SharedFileView>()
  /** Keyed `peerId|transferId` — ids are only unique within one peer. */
  #receives = new Map<string, ReceiveTransfer>()
  /** Keyed `peerId|seq` for routing binary frames. */
  #receiveBySeq = new Map<string, ReceiveTransfer>()
  /** Which shared files each peer has already been offered. */
  #offered = new Map<string, Set<string>>()
  #peers = new Map<string, string>()
  #usedNames = new Set<string>()
  /** Downloads the user has approved that are waiting for a slot. */
  #queuedAccepts = new Set<ReceiveTransfer>()
  /**
   * Downloads whose accept() is still running.
   *
   * accept() is async — it opens storage before reaching TRANSFERRING — so a
   * loop that accepts five files in one tick would find every slot idle five
   * times. Claiming synchronously closes that gap.
   */
  #claimed = new Set<ReceiveTransfer>()
  /** Peers with an offer loop running, and whether it should go round again. */
  #offering = new Map<string, boolean>()
  #nextSeq = 1
  #watchdog: ReturnType<typeof setInterval> | null = null
  /** When the watchdog last ran, so a late tick can be recognised as a freeze. */
  #lastTick = Date.now()

  constructor(linkFor: (peerId: string) => PeerLink, prefs: StoragePreferences) {
    this.#linkFor = linkFor
    this.#prefs = prefs
    this.#watchdog = setInterval(() => this.#tick(), TICK_MS)
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
    for (const transfer of this.#sendsByShared.get(sharedId) ?? []) {
      transfer.cancel()
      this.#sends.delete(transfer.id)
    }
    this.#sendsByShared.delete(sharedId)
    this.#sharedViews.delete(sharedId)
    for (const key of [...this.#hashers.keys()]) {
      if (key.startsWith(`${sharedId}|`)) this.#hashers.delete(key)
    }
    for (const offered of this.#offered.values()) offered.delete(sharedId)
    this.#changed()
  }

  /** Creates a transfer to this peer for every shared file it has not been offered. */
  #offerShared(peerId: string): void {
    let offered = this.#offered.get(peerId)
    if (!offered) {
      offered = new Set()
      this.#offered.set(peerId, offered)
    }

    const link = this.#linkFor(peerId)
    const chunkSize = chunkSizeFor(link.maxFrameBytes?.())
    for (const entry of this.#shared) {
      if (offered.has(entry.id)) continue
      offered.add(entry.id)
      this.#addSend(
        new SendTransfer({
          id: randomId(8),
          seq: this.#nextSeq++ & 0xffff,
          peerId,
          peerName: this.#peers.get(peerId) ?? 'Device',
          file: entry.file,
          ...(entry.relPath ? {relPath: entry.relPath} : {}),
          batchId: entry.batchId,
          link,
          chunkSize,
          hasher: this.#hasherFor(entry, chunkSize),
          onChange: () => this.#changed()
        }),
        entry.id
      )
    }

    this.#startOffers(peerId)
  }

  #hasherFor(entry: SharedFile, chunkSize: number): ChunkTreeHasher {
    const key = `${entry.id}|${chunkSize}`
    let hasher = this.#hashers.get(key)
    if (!hasher) {
      hasher = new ChunkTreeHasher(entry.file.size, chunkSize, Math.ceil(entry.file.size / chunkSize))
      this.#hashers.set(key, hasher)
    }
    return hasher
  }

  #addSend(transfer: SendTransfer, sharedId: string, replacing?: SendTransfer): void {
    transfer.sharedId = sharedId
    this.#sends.set(transfer.id, transfer)
    const list = this.#sendsByShared.get(sharedId) ?? []
    const at = replacing ? list.indexOf(replacing) : -1
    if (at === -1) list.push(transfer)
    else list[at] = transfer
    this.#sendsByShared.set(sharedId, list)
  }

  /**
   * Offers every queued file to a device, paced.
   *
   * Every shared file is offered, not one at a time: an offer is metadata, and
   * holding the rest back meant a device could see only the first of the files
   * shared with it. But not all at once either — the receiving end rate limits
   * its control channel, and a send resolves once the message is buffered, not
   * delivered, so awaiting each one never paced anything. A drop of hundreds of
   * files used to lose the tail of its offers without a word.
   *
   * One loop per device; a call while it runs asks it to go round again.
   */
  #startOffers(peerId: string): void {
    if (this.#offering.has(peerId)) {
      this.#offering.set(peerId, true)
      return
    }
    this.#offering.set(peerId, false)
    void this.#offerLoop(peerId)
  }

  async #offerLoop(peerId: string): Promise<void> {
    try {
      do {
        this.#offering.set(peerId, false)
        let sent = 0
        for (const transfer of [...this.#sends.values()]) {
          if (transfer.peerId !== peerId || transfer.state !== 'QUEUED') continue
          if (!this.#peers.has(peerId)) return
          await transfer.start()
          if (++sent % OFFER_GROUP === 0) {
            await new Promise(resolve => setTimeout(resolve, (OFFER_GROUP * 1000) / OFFERS_PER_SECOND))
          }
        }
      } while (this.#offering.get(peerId) === true)
    } finally {
      this.#offering.delete(peerId)
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
    for (const transfer of this.#transfersOf(peerId)) transfer.onPeerLost()
    this.#changed()
  }

  peerRestored(peerId: string): void {
    for (const transfer of this.#transfersOf(peerId)) transfer.onPeerRestored()
    if (this.#peers.has(peerId)) this.#startOffers(peerId)
    this.#changed()
  }

  /** The device is gone for good: stop its transfers and forget what it was offered. */
  peerRemoved(peerId: string): void {
    for (const transfer of this.#sends.values()) {
      if (transfer.peerId === peerId) transfer.cancel(false)
    }
    for (const [key, transfer] of this.#receives) {
      if (transfer.peerId !== peerId) continue
      transfer.dispose()
      this.#receives.delete(key)
      this.#receiveBySeq.delete(seqKey(peerId, transfer.seq))
      this.#queuedAccepts.delete(transfer)
      this.#claimed.delete(transfer)
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
    const existing = this.#receives.get(id)
    if (existing) {
      // Offered again: the sender never heard our answer.
      existing.onOfferRepeated()
      return
    }

    let lastState: string | null = null
    const transfer: ReceiveTransfer = new ReceiveTransfer({
      offer,
      peerId,
      peerName: this.#peers.get(peerId) ?? 'Device',
      link: this.#linkFor(peerId),
      onChange: () => {
        // A download changing state — finishing, failing, being cancelled — is
        // what frees a slot. Progress alone cannot, and is far more frequent.
        if (transfer.state !== lastState) {
          lastState = transfer.state
          this.#pumpDownloads(peerId)
        }
        this.#changed()
      },
      storagePrefs: this.#prefs,
      reserveName: name => {
        const unique = uniqueFilename(name, this.#usedNames)
        this.#usedNames.add(unique)
        return unique
      }
    })
    lastState = transfer.state

    this.#receives.set(id, transfer)
    this.#receiveBySeq.set(seqKey(peerId, transfer.seq), transfer)
    void transfer.prepare()
    this.#changed()
  }

  // ------------------------------------------------------------- user actions

  /**
   * Starts a download, or puts it in line for a slot.
   *
   * A large file gets the connection to itself: several large downloads
   * sharing one link all crawl and none finishes, whereas one at a time the
   * first is usable while the rest arrive, and an interruption costs one
   * part-file rather than five. Small files are different — for them the round
   * trips around the bytes dominate — so a few run side by side.
   */
  accept(id: string): void {
    const transfer = this.#findReceive(id)
    if (!transfer || transfer.state !== 'WAITING_FOR_ACCEPT') return
    if (this.#claimed.has(transfer) || this.#queuedAccepts.has(transfer)) return

    // Started straight from the click when a slot is free and nothing from the
    // same device is ahead of it, so a save picker is still allowed to open.
    const waiting = [...this.#queuedAccepts].some(queued => queued.peerId === transfer.peerId)
    if (!waiting && this.#hasSlot(transfer)) {
      this.#beginDownload(transfer)
      return
    }
    this.#queuedAccepts.add(transfer)
    this.#pumpDownloads(transfer.peerId)
  }

  #beginDownload(transfer: ReceiveTransfer): void {
    this.#claimed.add(transfer)
    // Once accept() settles the transfer holds its slot by state instead —
    // or, if the save dialog was dismissed, hands it back.
    void transfer.accept().finally(() => {
      this.#claimed.delete(transfer)
      this.#pumpDownloads(transfer.peerId)
    })
  }

  /**
   * Takes a download back out of the queue, leaving the offer intact.
   *
   * Deliberately not a cancel: cancelling is terminal, so a queued file that
   * was cancelled could never be downloaded afterwards. Since a queued transfer
   * never left WAITING_FOR_ACCEPT — only the accept was held back — dropping it
   * from the queue puts the Download button back exactly as it was.
   */
  unqueue(id: string): void {
    const transfer = this.#findReceive(id)
    if (!transfer || !this.#queuedAccepts.delete(transfer)) return
    transfer.queuePosition = null
    this.#pumpDownloads(transfer.peerId)
    this.#changed()
  }

  /** Whether a download from this transfer's device could start now. */
  #hasSlot(candidate: ReceiveTransfer): boolean {
    let running = 0
    let allSmall = candidate.size <= SMALL_FILE_BYTES
    for (const transfer of this.#receives.values()) {
      if (transfer === candidate || transfer.peerId !== candidate.peerId) continue
      if (!this.#claimed.has(transfer) && !isMoving(transfer.state)) continue
      running++
      if (transfer.size > SMALL_FILE_BYTES) allSmall = false
    }
    return running === 0 || (allSmall && running < MAX_PARALLEL_SMALL_DOWNLOADS)
  }

  /**
   * Numbers the waiting downloads and starts whichever now fit, in the order
   * they were accepted. Called on every download state change, so finishing,
   * failing or cancelling the running one all release the queue.
   */
  #pumpDownloads(peerId: string): void {
    let changed = false
    let position = 0
    for (const transfer of [...this.#queuedAccepts]) {
      if (transfer.peerId !== peerId) continue
      if (transfer.state !== 'WAITING_FOR_ACCEPT') {
        // Cancelled, or started some other way: no longer queued.
        this.#queuedAccepts.delete(transfer)
        changed ||= transfer.queuePosition !== null
        transfer.queuePosition = null
        continue
      }
      // Strictly in order: a small file does not jump a large one ahead of it.
      if (position === 0 && this.#hasSlot(transfer)) {
        this.#queuedAccepts.delete(transfer)
        transfer.queuePosition = null
        changed = true
        this.#beginDownload(transfer)
        continue
      }
      position++
      if (transfer.queuePosition !== position) {
        transfer.queuePosition = position
        changed = true
      }
    }
    if (changed) this.#changed()
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
    this.#sends.get(id)?.cancel()
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

  /** Retries in place: same device, same batch, same place in the list. */
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
      ...(previous.batchId ? {batchId: previous.batchId} : {}),
      link: this.#linkFor(previous.peerId),
      chunkSize: previous.chunkSize,
      hasher: previous.hasher,
      onChange: () => this.#changed()
    })

    this.#sends.delete(id)
    this.#addSend(replacement, previous.sharedId, previous)
    this.#startOffers(previous.peerId)
    this.#changed()
  }

  // ---------------------------------------------------------------- accessors

  /** Dropped files, each with one row per device it was offered to. */
  sharedFiles(): SharedFileView[] {
    return this.#shared.map(entry => {
      const view = keepIfSame<SharedFileView>(this.#sharedViews.get(entry.id), {
        id: entry.id,
        name: entry.file.name,
        size: entry.file.size,
        addedAt: entry.addedAt,
        batchId: entry.batchId,
        transfers: (this.#sendsByShared.get(entry.id) ?? []).map(transfer => transfer.view())
      })
      this.#sharedViews.set(entry.id, view)
      return view
    })
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

  /** Bytes are moving, or about to, in either direction. What the wake lock follows. */
  hasMovingTransfers(): boolean {
    for (const transfer of this.#sends.values()) if (isMoving(transfer.state)) return true
    for (const transfer of this.#receives.values()) if (isMoving(transfer.state)) return true
    return false
  }

  /**
   * Closing the page now would lose something: a transfer is moving, or a file
   * shared from here is still waiting for a device to take it. An offer
   * *to* this device that nobody has accepted is not a reason to stay open.
   */
  hasUnfinishedWork(): boolean {
    if (this.hasMovingTransfers()) return true
    for (const transfer of this.#sends.values()) {
      if (transfer.state === 'QUEUED' || transfer.state === 'WAITING_FOR_ACCEPT') return true
    }
    return false
  }

  /** Cancels everything in flight and clears history, for a fresh session. */
  reset(): void {
    this.stopAll()
    for (const transfer of this.#receives.values()) transfer.dispose()
    this.#sends.clear()
    this.#sendsByShared.clear()
    this.#hashers.clear()
    this.#sharedViews.clear()
    this.#receives.clear()
    this.#receiveBySeq.clear()
    this.#queuedAccepts.clear()
    this.#claimed.clear()
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

  *#transfersOf(peerId: string): Iterable<SendTransfer | ReceiveTransfer> {
    for (const transfer of this.#sends.values()) if (transfer.peerId === peerId) yield transfer
    for (const transfer of this.#receives.values()) if (transfer.peerId === peerId) yield transfer
  }

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
    const overdue = now - this.#lastTick - TICK_MS
    this.#lastTick = now
    if (overdue > TICK_MS) {
      for (const transfer of this.#sends.values()) transfer.creditFrozen(overdue)
      for (const transfer of this.#receives.values()) transfer.creditFrozen(overdue)
    }

    for (const transfer of this.#sends.values()) transfer.tick(now)
    for (const transfer of this.#receives.values()) transfer.tick(now)
    for (const peerId of this.#peers.keys()) {
      // Belt and braces: both queues normally move on events, and a single
      // missed one used to strand everything behind it. A queue that re-checks
      // itself cannot get permanently stuck.
      if (this.#hasQueuedOffers(peerId)) this.#startOffers(peerId)
      this.#pumpDownloads(peerId)
    }
  }

  #hasQueuedOffers(peerId: string): boolean {
    for (const transfer of this.#sends.values()) {
      if (transfer.peerId === peerId && transfer.state === 'QUEUED') return true
    }
    return false
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
