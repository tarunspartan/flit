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
import {isTerminal, type SharedFileView, type TransferView} from './states.ts'

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
  #nextSeq = 1
  #watchdog: ReturnType<typeof setInterval> | null = null

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
        link: this.#linkFor(peerId),
        onChange: () => this.#changed()
      })
      transfer.sharedId = entry.id
      this.#sends.set(transfer.id, transfer)
    }

    this.#pumpQueue(peerId)
  }

  /** One active transfer per device, so each gets the full pipe in turn. */
  #pumpQueue(peerId: string): void {
    const queue = [...this.#sends.values()].filter(transfer => transfer.peerId === peerId)
    const busy = queue.some(transfer => transfer.state !== 'QUEUED' && !isTerminal(transfer.state))

    let position = 0
    for (const transfer of queue) {
      if (transfer.state === 'QUEUED') transfer.queuePosition = ++position
    }
    if (busy) return

    const next = queue.find(transfer => transfer.state === 'QUEUED')
    if (next) void next.start()
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
      onChange: () => this.#changed(),
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

  accept(id: string): void {
    void this.#findReceive(id)?.accept()
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
      transfers: [...this.#sends.values()]
        .filter(transfer => transfer.sharedId === entry.id)
        .map(transfer => transfer.view())
    }))
  }

  /** Files other devices are sending to this one. */
  incoming(): TransferView[] {
    return [...this.#receives.values()]
      .map(transfer => transfer.view())
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  }

  hasActiveTransfers(): boolean {
    const active = (view: TransferView) => !isTerminal(view.state)
    return (
      [...this.#sends.values()].some(transfer => active(transfer.view())) ||
      [...this.#receives.values()].some(transfer => active(transfer.view()))
    )
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
    for (const transfer of this.#sends.values()) transfer.checkStall(now)
    for (const transfer of this.#receives.values()) transfer.checkStall(now)
    for (const peerId of this.#peers.keys()) this.#pumpQueue(peerId)
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
