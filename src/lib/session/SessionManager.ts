import {CHUNK_SIZE, LIMITS, MAX_PEERS, TIMEOUTS} from '../core/config.ts'
import {AppError, friendly, toAppError, type ErrorCode} from '../core/errors.ts'
import {Emitter} from '../core/events.ts'
import {decodeChunk} from '../protocol/frame.ts'
import {message, type ControlMessage} from '../protocol/messages.ts'
import {MessageRateLimiter, parseControl} from '../protocol/validate.ts'
import {
  describeStorageSupport,
  purgeOpfs,
  type StoragePreferences,
  type StorageSupport
} from '../storage/index.ts'
import {TrysteroTransport} from '../transport/TrysteroTransport.ts'
import {UNKNOWN_PATH, type NetworkPath, type PeerId} from '../transport/Transport.ts'
import type {PeerLink} from '../transfer/PeerLink.ts'
import {TransferManager} from '../transfer/TransferManager.ts'
import type {SharedFileView, TransferView} from '../transfer/states.ts'
import {guessDeviceKind, loadDeviceName, sanitizeDeviceName, saveDeviceName} from '../utils/device.ts'
import {RoomManager, type RoomRole} from './RoomManager.ts'

export type SessionStatus = 'starting' | 'open' | 'ended'

/** How long signaling must stay unreachable before the UI mentions it. */
const SIGNALING_GRACE_MS = 10_000

export interface PeerInfo {
  id: string
  name: string
  kind: string
  present: boolean
  approved: boolean
  path: NetworkPath
}

export interface SessionNotice {
  id: string
  title: string
  message: string
  tone: 'info' | 'error'
}

export interface SessionSnapshot {
  status: SessionStatus
  /** False only when no signaling relay has been reachable for a while. */
  signalingReady: boolean
  /** 'guest' when this room was entered by code rather than opened here. */
  role: RoomRole | null
  /** True once any device has joined — distinguishes "empty" from "not found". */
  everHadPeer: boolean
  code: string | null
  display: string | null
  shareUrl: string | null
  expiresAt: number | null
  selfName: string
  peers: PeerInfo[]
  /** Devices waiting to be let in, when approval is required. */
  pending: PeerInfo[]
  shared: SharedFileView[]
  incoming: TransferView[]
  error: {code: ErrorCode; title: string; message: string; retryable: boolean} | null
  notices: SessionNotice[]
  storage: StorageSupport
  localOnly: boolean
  requireApproval: boolean
  alwaysChooseLocation: boolean
  busy: boolean
}

interface PeerRecord {
  id: string
  name: string
  kind: string
  approved: boolean
  present: boolean
  path: NetworkPath
  limiter: MessageRateLimiter
  dropTimer: ReturnType<typeof setTimeout> | null
}

interface SessionEvents extends Record<string, unknown> {
  change: void
}

/**
 * The application-level API the UI talks to.
 *
 * A room is a small group, not a pair: every device in it can send to and
 * receive from every other. Files are shared with the room, so devices that
 * arrive later are offered whatever was dropped before they showed up.
 *
 * Nothing above this file mentions SDP, ICE, DataChannels or Trystero.
 */
export class SessionManager {
  #emitter = new Emitter<SessionEvents>()
  #rooms = new RoomManager()
  #transport: TrysteroTransport | null = null
  #transfers: TransferManager

  #status: SessionStatus = 'starting'
  #selfName = loadDeviceName()
  #selfKind = guessDeviceKind()
  #peers = new Map<PeerId, PeerRecord>()
  #blocked = new Set<PeerId>()
  #everHadPeer = false
  #signalingOk = true
  #signalingBadSince: number | null = null
  #healthTimer: ReturnType<typeof setInterval> | null = null
  #busy = false
  #error: AppError | null = null
  #notices: SessionNotice[] = []
  #storage: StorageSupport = describeStorageSupport()
  #prefs: StoragePreferences = {alwaysChooseLocation: false}
  #localOnly = false
  #requireApproval = false
  #expiryTimer: ReturnType<typeof setTimeout> | null = null
  #unsubscribe: (() => void)[] = []

  constructor() {
    this.#transfers = new TransferManager(peerId => this.#linkFor(peerId), this.#prefs)
    this.#transfers.on('update', () => this.#changed())
    this.#transfers.on('notice', notice => this.#notice(notice.title, notice.message, notice.tone))
    // Clear anything a previous session left in OPFS after an abrupt exit.
    void purgeOpfs()
  }

  subscribe(listener: () => void): () => void {
    return this.#emitter.on('change', listener)
  }

  snapshot(): SessionSnapshot {
    const room = this.#rooms.current
    const peers = [...this.#peers.values()]
    return {
      status: this.#status,
      signalingReady: this.#signalingOk,
      role: room?.role ?? null,
      everHadPeer: this.#everHadPeer,
      code: room?.code ?? null,
      display: room?.display ?? null,
      shareUrl: this.#rooms.shareUrl(),
      expiresAt: room?.expiresAt ?? null,
      selfName: this.#selfName,
      peers: peers.filter(peer => peer.approved).map(toPeerInfo),
      pending: peers.filter(peer => !peer.approved).map(toPeerInfo),
      shared: this.#transfers.sharedFiles(),
      incoming: this.#transfers.incoming(),
      error: this.#error ? {code: this.#error.code, ...friendly(this.#error)} : null,
      notices: this.#notices,
      storage: this.#storage,
      localOnly: this.#localOnly,
      requireApproval: this.#requireApproval,
      alwaysChooseLocation: this.#prefs.alwaysChooseLocation,
      busy: this.#busy
    }
  }

  // ------------------------------------------------------------ session start

  /** Opens a room. Called automatically on load — no click required. */
  async openRoom(): Promise<void> {
    await this.#start(() => this.#rooms.create())
  }

  async joinRoom(input: string): Promise<void> {
    await this.#start(() => this.#rooms.join(input))
  }

  async #start(makeRoom: () => {code: string}): Promise<void> {
    if (this.#busy) return
    this.#busy = true
    this.#error = null
    this.#status = 'starting'
    this.#changed()

    try {
      await this.#teardownTransport()
      this.#transfers.reset()
      this.#clearPeers()
      this.#everHadPeer = false

      const room = makeRoom()
      const transport = new TrysteroTransport({localOnly: this.#localOnly})
      this.#transport = transport
      this.#wireTransport(transport)
      await transport.join(room.code)

      this.#status = 'open'
      this.#armExpiry()
      this.#watchSignaling()
    } catch (err) {
      this.#error = toAppError(err, 'connection-failed')
      this.#status = 'ended'
      this.#rooms.clear()
      await this.#teardownTransport()
    } finally {
      this.#busy = false
      this.#changed()
    }
  }

  #wireTransport(transport: TrysteroTransport): void {
    this.#unsubscribe = [
      transport.on('peerJoin', ({peerId}) => this.#onPeerJoin(peerId)),
      transport.on('peerLeave', ({peerId}) => this.#onPeerLeave(peerId)),
      transport.on('control', ({peerId, raw}) => this.#onControl(peerId, raw)),
      transport.on('chunk', ({peerId, data}) => this.#onChunk(peerId, data)),
      transport.on('path', ({peerId, path}) => {
        const peer = this.#peers.get(peerId)
        if (!peer) return
        peer.path = path
        this.#changed()
      }),
      transport.on('error', ({error}) => {
        this.#error = error
        this.#changed()
      })
    ]
  }

  // -------------------------------------------------------------- peer events

  #onPeerJoin(peerId: PeerId): void {
    if (this.#blocked.has(peerId)) return

    const existing = this.#peers.get(peerId)
    if (existing) {
      // A device coming back after a connection blip keeps its approval.
      existing.present = true
      if (existing.dropTimer !== null) clearTimeout(existing.dropTimer)
      existing.dropTimer = null
      void this.#sendHello(peerId)
      if (existing.approved) this.#transfers.peerRestored(peerId)
      this.#changed()
      return
    }

    if (this.#peers.size >= MAX_PEERS) {
      void this.#transport
        ?.sendControl(peerId, message({t: 'SESSION_END', reason: 'full'}))
        .catch(() => {})
      return
    }

    this.#everHadPeer = true
    this.#peers.set(peerId, {
      id: peerId,
      name: 'Device',
      kind: 'desktop',
      // Holding the room code is the credential; approval is opt-in for people
      // who want a prompt before a device can join (see settings).
      approved: !this.#requireApproval,
      present: true,
      path: this.#transport?.pathFor(peerId) ?? UNKNOWN_PATH,
      limiter: new MessageRateLimiter(),
      dropTimer: null
    })

    void this.#sendHello(peerId)
    this.#changed()
  }

  #onPeerLeave(peerId: PeerId): void {
    const peer = this.#peers.get(peerId)
    if (!peer) return

    peer.present = false
    peer.path = UNKNOWN_PATH
    if (peer.approved) this.#transfers.peerLost(peerId)

    // Give the device a window to come back before its transfers are discarded.
    if (peer.dropTimer !== null) clearTimeout(peer.dropTimer)
    peer.dropTimer = setTimeout(() => {
      this.#transfers.peerRemoved(peerId)
      this.#peers.delete(peerId)
      this.#changed()
    }, TIMEOUTS.reconnectWindowMs)

    this.#changed()
  }

  #onControl(peerId: PeerId, raw: unknown): void {
    const peer = this.#peers.get(peerId)
    if (!peer) return
    if (!peer.limiter.allow()) return // Flood protection.

    const parsed = parseControl(raw)
    if (!parsed.ok) {
      if (parsed.reason === 'incompatible-version' && !this.#error) {
        this.#error = new AppError('protocol-version')
        this.#changed()
      }
      return
    }

    const msg = parsed.message

    // Before approval the handshake is all that is accepted.
    if (!peer.approved) {
      if (msg.t === 'HELLO') this.#onHello(peer, msg)
      else if (msg.t === 'SESSION_END') this.#onSessionEnd(peerId, msg.reason)
      return
    }

    switch (msg.t) {
      case 'HELLO':
        this.#onHello(peer, msg)
        break
      case 'SESSION_APPROVE':
        // Nothing to do: this build admits on the code plus per-file consent.
        break
      case 'SESSION_END':
        this.#onSessionEnd(peerId, msg.reason)
        break
      default:
        this.#transfers.handleControl(peerId, msg)
    }
  }

  #onChunk(peerId: PeerId, data: Uint8Array): void {
    const peer = this.#peers.get(peerId)
    if (!peer?.approved) return
    const frame = decodeChunk(data, CHUNK_SIZE)
    if (!frame) return // Malformed frames are dropped, never guessed at.
    this.#transfers.handleChunk(peerId, frame)
  }

  #onHello(peer: PeerRecord, msg: Extract<ControlMessage, {t: 'HELLO'}>): void {
    peer.name = sanitizeDeviceName(msg.deviceName)
    peer.kind = sanitizeDeviceName(msg.deviceKind)
    // Only now do we know what to call the device, so this is where a peer
    // becomes ready to be offered the room's files.
    if (peer.approved) this.#transfers.peerReady(peer.id, peer.name)
    this.#changed()
  }

  #onSessionEnd(peerId: PeerId, reason: 'user' | 'expired' | 'blocked' | 'full'): void {
    if (reason === 'full') {
      this.#error = new AppError('room-full')
      this.#status = 'ended'
      void this.#teardownTransport()
      this.#changed()
      return
    }
    // One device leaving is not the end of the room for everyone else.
    this.#transfers.peerRemoved(peerId)
    const peer = this.#peers.get(peerId)
    if (peer?.dropTimer !== null && peer?.dropTimer !== undefined) clearTimeout(peer.dropTimer)
    this.#peers.delete(peerId)
    this.#changed()
  }

  // ------------------------------------------------------------- user actions

  approvePeer(peerId: string): void {
    const peer = this.#peers.get(peerId)
    if (!peer || peer.approved) return
    peer.approved = true
    void this.#transport
      ?.sendControl(peerId, message({t: 'SESSION_APPROVE', approved: true}))
      .catch(() => {})
    this.#transfers.peerReady(peerId, peer.name)
    this.#changed()
  }

  /** Removes a device and stops it rejoining for the rest of the session. */
  blockPeer(peerId: string): void {
    const peer = this.#peers.get(peerId)
    if (!peer) return
    this.#blocked.add(peerId)
    if (peer.dropTimer !== null) clearTimeout(peer.dropTimer)
    void this.#transport
      ?.sendControl(peerId, message({t: 'SESSION_END', reason: 'blocked'}))
      .catch(() => {})
    this.#transfers.peerRemoved(peerId)
    this.#peers.delete(peerId)
    this.#notice('Device removed', `${peer.name} was disconnected.`, 'info')
    this.#changed()
  }

  async endSession(): Promise<void> {
    for (const peer of this.#peers.values()) {
      if (!peer.approved) continue
      await this.#transport
        ?.sendControl(peer.id, message({t: 'SESSION_END', reason: 'user'}))
        .catch(() => {})
    }
    this.#end(null)
  }

  /** Shares files with the room. Devices may join afterwards and still get them. */
  shareFiles(files: File[]): void {
    if (this.#status !== 'open') return
    this.#transfers.addFiles(files)
  }

  unshare(sharedId: string): void {
    this.#transfers.unshare(sharedId)
  }

  accept(id: string): void {
    this.#transfers.accept(id)
  }
  reject(id: string): void {
    this.#transfers.reject(id)
  }
  cancel(id: string): void {
    this.#transfers.cancel(id)
  }
  cancelAll(): void {
    this.#transfers.cancelAll()
  }
  pause(id: string): void {
    this.#transfers.pause(id)
  }
  resume(id: string): void {
    this.#transfers.resume(id)
  }
  retry(id: string): void {
    this.#transfers.retry(id)
  }
  saveAgain(id: string): void {
    this.#transfers.saveAgain(id)
  }

  setDeviceName(name: string): void {
    this.#selfName = saveDeviceName(name)
    for (const peer of this.#peers.values()) void this.#sendHello(peer.id)
    this.#changed()
  }

  setLocalOnly(enabled: boolean): void {
    this.#localOnly = enabled
    this.#changed()
  }

  setRequireApproval(enabled: boolean): void {
    this.#requireApproval = enabled
    this.#changed()
  }

  setAlwaysChooseLocation(enabled: boolean): void {
    this.#prefs = {...this.#prefs, alwaysChooseLocation: enabled}
    this.#transfers.setPreferences(this.#prefs)
    this.#changed()
  }

  dismissNotice(id: string): void {
    this.#notices = this.#notices.filter(notice => notice.id !== id)
    this.#changed()
  }

  clearError(): void {
    this.#error = null
    this.#changed()
  }

  hasActiveTransfers(): boolean {
    return this.#transfers.hasActiveTransfers()
  }

  // ---------------------------------------------------------------- internals

  #linkFor(peerId: PeerId): PeerLink {
    return {
      isConnected: () => {
        const peer = this.#peers.get(peerId)
        return this.#status === 'open' && peer?.present === true && peer.approved
      },
      sendControl: async (msg: ControlMessage) => {
        const transport = this.#transport
        if (!transport) throw new AppError('connection-lost')
        await transport.sendControl(peerId, msg)
      },
      sendChunk: async frame => {
        const transport = this.#transport
        if (!transport) throw new AppError('connection-lost')
        await transport.sendChunk(peerId, frame)
      }
    }
  }

  async #sendHello(peerId: PeerId): Promise<void> {
    await this.#transport
      ?.sendControl(
        peerId,
        message({
          t: 'HELLO',
          sessionId: this.#transport.selfId.slice(0, 32),
          deviceName: this.#selfName,
          deviceKind: this.#selfKind,
          maxFileSize: LIMITS.maxFileSize,
          supportsResume: true
        })
      )
      .catch(() => {
        // The peer may still be completing its handshake; HELLO is re-sent on
        // reconnect, and nothing proceeds without it anyway.
      })
  }

  /**
   * Relay sockets drop and reconnect routinely, so a problem is only surfaced
   * once it has persisted — otherwise the UI would flicker a warning during
   * every ordinary reconnect, and once on every cold start.
   */
  #watchSignaling(): void {
    if (this.#healthTimer !== null) clearInterval(this.#healthTimer)
    this.#signalingBadSince = null
    this.#signalingOk = true

    this.#healthTimer = setInterval(() => {
      const now = Date.now()
      if (this.#transport?.signalingReady() === true) this.#signalingBadSince = null
      else this.#signalingBadSince ??= now

      const ok =
        this.#signalingBadSince === null || now - this.#signalingBadSince < SIGNALING_GRACE_MS
      if (ok !== this.#signalingOk) {
        this.#signalingOk = ok
        this.#changed()
      }
    }, 3000)
  }

  #armExpiry(): void {
    if (this.#expiryTimer !== null) clearTimeout(this.#expiryTimer)
    const room = this.#rooms.current
    if (!room) return
    this.#expiryTimer = setTimeout(() => {
      if (this.#status !== 'open') return
      for (const peer of this.#peers.values()) {
        void this.#transport
          ?.sendControl(peer.id, message({t: 'SESSION_END', reason: 'expired'}))
          .catch(() => {})
      }
      this.#end(new AppError('room-expired'))
    }, Math.max(0, room.expiresAt - Date.now()))
  }

  #end(error: AppError | null): void {
    this.#transfers.stopAll()
    this.#error = error
    this.#status = 'ended'
    this.#clearPeers()
    this.#rooms.clear()
    if (this.#expiryTimer !== null) clearTimeout(this.#expiryTimer)
    this.#expiryTimer = null
    void this.#teardownTransport()
    this.#changed()
  }

  #clearPeers(): void {
    for (const peer of this.#peers.values()) {
      if (peer.dropTimer !== null) clearTimeout(peer.dropTimer)
    }
    this.#peers.clear()
  }

  async #teardownTransport(): Promise<void> {
    if (this.#healthTimer !== null) clearInterval(this.#healthTimer)
    this.#healthTimer = null
    this.#signalingOk = true
    this.#signalingBadSince = null
    for (const off of this.#unsubscribe) off()
    this.#unsubscribe = []
    const transport = this.#transport
    this.#transport = null
    if (transport) await transport.leave()
  }

  #notice(title: string, text: string, tone: 'info' | 'error'): void {
    const notice: SessionNotice = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      message: text,
      tone
    }
    this.#notices = [...this.#notices.slice(-3), notice]
    this.#changed()
    // Toasts clear themselves; errors linger a little longer than confirmations.
    setTimeout(() => this.dismissNotice(notice.id), tone === 'error' ? 9000 : 5000)
  }

  #changed(): void {
    this.#emitter.emit('change', undefined)
  }
}

function toPeerInfo(peer: PeerRecord): PeerInfo {
  return {
    id: peer.id,
    name: peer.name,
    kind: peer.kind,
    present: peer.present,
    approved: peer.approved,
    path: peer.path
  }
}
