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
import {agreeKind, withKind} from '../transport/pathClassifier.ts'
import {UNKNOWN_PATH, type NetworkPath, type PathKind, type PeerId} from '../transport/Transport.ts'
import type {PeerLink} from '../transfer/PeerLink.ts'
import {TransferManager} from '../transfer/TransferManager.ts'
import type {SharedFileView, TransferView} from '../transfer/states.ts'
import {
  guessDeviceKind,
  loadDeviceId,
  loadDeviceName,
  sanitizeDeviceName,
  saveDeviceName
} from '../utils/device.ts'
import {randomId} from '../core/ids.ts'
import {sanitizeSharedText} from '../utils/text.ts'
import {RoomManager, type RoomRole} from './RoomManager.ts'

export type SessionStatus = 'starting' | 'open' | 'ended'

/**
 * Losing signaling is usually a network handover, not an outage, so the UI says
 * nothing at all for the first stretch, then says it is retrying, and only calls
 * it broken once it has stayed gone. Announcing "can't reach the internet" for
 * something that fixes itself in seconds is worse than saying nothing.
 */
const SIGNALING_GRACE_MS = 10_000
const SIGNALING_OFFLINE_MS = 30_000

export type SignalingHealth = 'ok' | 'retrying' | 'offline'

/**
 * How long to wait for the peer's own read of the connection before showing
 * ours alone. Saying "Connecting…" briefly is better than saying "Internet" and
 * flipping to "Local network" a moment later — but a peer on an older build
 * never answers at all, so this cannot wait forever.
 */
const PATH_AGREE_MS = 2500

export interface PeerInfo {
  id: string
  name: string
  kind: string
  present: boolean
  approved: boolean
  path: NetworkPath
}

/** A link or note shared with the room. Local only; never persisted. */
export interface SharedText {
  id: string
  text: string
  /** Who sent it, or null when it was this device. */
  from: string | null
  at: number
}

export interface SessionNotice {
  id: string
  title: string
  message: string
  tone: 'info' | 'error'
}

export interface SessionSnapshot {
  status: SessionStatus
  /** Only leaves 'ok' once no signaling relay has been reachable for a while. */
  signaling: SignalingHealth
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
  texts: SharedText[]
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
  /** Stable per browser profile, once HELLO arrives. Null when the peer has none. */
  deviceId: string | null
  /** True when this "peer" is another tab of this very device. */
  isSelf: boolean
  /** Decides which of two connections from one device is the stale one. */
  joinedAt: number
  approved: boolean
  present: boolean
  /** This device's own read of the link — never shown on its own. */
  path: NetworkPath
  /** The peer's read of the same link, once it has told us. */
  peerKind: PathKind | null
  /** Cleared once the peer answers, or once waiting for it has run out. */
  agreeTimer: ReturnType<typeof setTimeout> | null
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
  #selfDeviceId = loadDeviceId()
  #peers = new Map<PeerId, PeerRecord>()
  #blocked = new Set<PeerId>()
  #everHadPeer = false
  #signaling: SignalingHealth = 'ok'
  #signalingBadSince: number | null = null
  #healthTimer: ReturnType<typeof setInterval> | null = null
  #busy = false
  #error: AppError | null = null
  #notices: SessionNotice[] = []
  #texts: SharedText[] = []
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
    // Other tabs of this same device are peers on the wire but not devices to
    // show, send to, or count.
    const peers = [...this.#peers.values()].filter(peer => !peer.isSelf)
    return {
      status: this.#status,
      signaling: this.#signaling,
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
      texts: this.#texts,
      storage: this.#storage,
      localOnly: this.#localOnly,
      requireApproval: this.#requireApproval,
      alwaysChooseLocation: this.#prefs.alwaysChooseLocation,
      busy: this.#busy
    }
  }

  // ------------------------------------------------------------ session start

  /**
   * Opens a room. Called automatically on load — no click required.
   *
   * Resolves to whether the room actually opened. Failures are reported through
   * the snapshot rather than thrown, so a caller that needs to act on the
   * outcome — the sidebar's join form closing itself — has to be told directly.
   */
  async openRoom(): Promise<boolean> {
    return this.#start(() => this.#rooms.create())
  }

  async joinRoom(input: string): Promise<boolean> {
    return this.#start(() => this.#rooms.join(input))
  }

  /**
   * Rebuilds the connection to the current room, keeping the code.
   *
   * Only ever called because someone pressed the button. An earlier version of
   * this ran automatically whenever signaling looked unhealthy, and since
   * "unhealthy" is also what a page looks like during its first few seconds, it
   * tore the transport down mid-handshake and stopped devices pairing at all.
   * Trystero re-announces every 5.3s on its own, so automatic rebuilding is not
   * only risky but redundant — this exists for the case where the page came
   * back from being frozen and its sockets never did.
   */
  async reconnect(): Promise<boolean> {
    const room = this.#rooms.current
    if (!room || this.#busy) return false
    return this.#start(() => room)
  }

  async #start(makeRoom: () => {code: string}): Promise<boolean> {
    if (this.#busy) return false
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
      return true
    } catch (err) {
      this.#error = toAppError(err, 'connection-failed')
      this.#status = 'ended'
      this.#rooms.clear()
      await this.#teardownTransport()
      return false
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
        this.#tellPeerOurPath(peer)
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
    if (this.#blocked.has(peerId)) {
      // Trystero knows nothing about blocking, so it happily pairs us again the
      // moment that device rejoins — with the same id, because selfId is minted
      // once per page load rather than per join. Ignoring it silently left the
      // other end showing a connection that would never do anything: "1
      // connected", no name, no transfers. Say no out loud instead.
      void this.#transport
        ?.sendControl(peerId, message({t: 'SESSION_END', reason: 'blocked'}))
        .catch(() => {})
      return
    }

    const existing = this.#peers.get(peerId)
    if (existing) {
      // A device coming back after a connection blip keeps its approval.
      existing.present = true
      if (existing.dropTimer !== null) clearTimeout(existing.dropTimer)
      existing.dropTimer = null
      void this.#sendHello(peerId)
      if (existing.approved && !existing.isSelf) this.#transfers.peerRestored(peerId)
      this.#changed()
      return
    }

    if (this.#peers.size >= MAX_PEERS) {
      void this.#transport
        ?.sendControl(peerId, message({t: 'SESSION_END', reason: 'full'}))
        .catch(() => {})
      return
    }

    // A device is connected, so any "couldn't connect" left over from a relay
    // that failed during the join is now simply untrue. One relay refusing is
    // not a failure when the others carried it.
    if (this.#error?.code === 'connection-failed') this.#error = null

    this.#everHadPeer = true
    this.#peers.set(peerId, {
      id: peerId,
      name: 'Device',
      kind: 'desktop',
      // Holding the room code is the credential; approval is opt-in for people
      // who want a prompt before a device can join (see settings).
      deviceId: null,
      isSelf: false,
      joinedAt: Date.now(),
      approved: !this.#requireApproval,
      present: true,
      path: this.#transport?.pathFor(peerId) ?? UNKNOWN_PATH,
      peerKind: null,
      agreeTimer: null,
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
    // A reconnect can land on an entirely different path, so both reads of the
    // old one are discarded rather than carried over.
    peer.path = UNKNOWN_PATH
    peer.peerKind = null
    if (peer.agreeTimer !== null) clearTimeout(peer.agreeTimer)
    peer.agreeTimer = null
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
      case 'TEXT_SHARE': {
        const text = sanitizeSharedText(msg.text, LIMITS.maxTextLength)
        // Empty after sanitizing means it was nothing but control characters.
        if (text) this.#addText({id: msg.id, text, from: peer.name, at: Date.now()})
        break
      }
      case 'PATH_NOTE':
        peer.peerKind = msg.kind
        if (peer.agreeTimer !== null) clearTimeout(peer.agreeTimer)
        peer.agreeTimer = null
        this.#changed()
        break
      default:
        this.#transfers.handleControl(peerId, msg)
    }
  }

  /**
   * Sends our read of the link and starts the clock on the peer's.
   *
   * Both devices do this off their own polling, so the exchange needs no
   * request/response: each simply publishes what it sees whenever that changes.
   */
  #tellPeerOurPath(peer: PeerRecord): void {
    if (peer.path.kind === 'unknown' || !peer.present) return

    void this.#transport
      ?.sendControl(peer.id, message({t: 'PATH_NOTE', kind: peer.path.kind}))
      .catch(() => {})

    if (peer.peerKind === null && peer.agreeTimer === null) {
      peer.agreeTimer = setTimeout(() => {
        peer.agreeTimer = null
        this.#changed() // Stop waiting; toPeerInfo falls back to our own read.
      }, PATH_AGREE_MS)
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
    peer.deviceId = msg.deviceId ?? null
    // Every device in the room meshes with every other, so a second tab of this
    // same device shows up here as a peer. It is not another device and there is
    // nothing to send it, so it is kept out of the roster entirely rather than
    // disconnected — two tabs each ending the other is a race with no winner.
    peer.isSelf = peer.deviceId !== null && peer.deviceId === this.#selfDeviceId

    if (peer.isSelf) {
      this.#transfers.peerRemoved(peer.id)
      this.#changed()
      return
    }

    this.#dropSupersededTwin(peer)
    // Only now do we know what to call the device, so this is where a peer
    // becomes ready to be offered the room's files.
    if (peer.approved) this.#transfers.peerReady(peer.id, peer.name)
    this.#changed()
  }

  /**
   * Retires an earlier connection from a device that has just connected again.
   *
   * Scanning the code twice leaves two live links to one phone, and every file
   * shared is then offered down both — duplicate transfers over the same radio.
   * The newer link wins because a re-scan almost always means the older tab is
   * stale, and the older one is told rather than dropped silently: it ends up on
   * the "Disconnected" screen instead of quietly talking to a peer that has
   * stopped listening.
   *
   * Only ever compares two *other* peers, so unlike the self case there is a
   * single decider and no race.
   */
  #dropSupersededTwin(current: PeerRecord): void {
    if (current.deviceId === null) return

    for (const other of [...this.#peers.values()]) {
      if (other.id === current.id) continue
      if (other.deviceId === null || other.deviceId !== current.deviceId) continue
      if (other.joinedAt > current.joinedAt) continue

      void this.#transport
        ?.sendControl(other.id, message({t: 'SESSION_END', reason: 'user'}))
        .catch(() => {})
      if (other.dropTimer !== null) clearTimeout(other.dropTimer)
      if (other.agreeTimer !== null) clearTimeout(other.agreeTimer)
      this.#transfers.peerRemoved(other.id)
      this.#peers.delete(other.id)
    }
  }

  #onSessionEnd(peerId: PeerId, reason: 'user' | 'expired' | 'blocked' | 'full'): void {
    if (reason === 'full') {
      this.#error = new AppError('room-full')
      this.#status = 'ended'
      void this.#teardownTransport()
      this.#changed()
      return
    }
    // Being turned away is not the same as someone leaving: without saying so,
    // the room just looks empty and the code looks broken.
    if (reason === 'blocked') this.#error = new AppError('peer-blocked')

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
  /**
   * Ends the session with a connected device, and nothing more.
   *
   * Deliberately not a block: the room code is the credential, so a device
   * holding it may come back by entering it again. Blocking here keyed on the
   * peer id, which Trystero mints per page load — weak enough that a fresh tab
   * walked past it, and strong enough that re-entering the code did nothing at
   * all, with no word to either side about why.
   */
  disconnectPeer(peerId: string): void {
    const peer = this.#peers.get(peerId)
    if (!peer) return
    if (peer.dropTimer !== null) clearTimeout(peer.dropTimer)
    if (peer.agreeTimer !== null) clearTimeout(peer.agreeTimer)
    void this.#transport
      ?.sendControl(peerId, message({t: 'SESSION_END', reason: 'user'}))
      .catch(() => {})
    this.#transfers.peerRemoved(peerId)
    this.#peers.delete(peerId)
    this.#notice('Device disconnected', `${peer.name} was disconnected.`, 'info')
    this.#changed()
  }

  /**
   * Refuses a device outright — the answer to an approval prompt, not a way to
   * end a session. It stays refused for as long as this page is open.
   */
  blockPeer(peerId: string): void {
    const peer = this.#peers.get(peerId)
    if (!peer) return
    this.#blocked.add(peerId)
    if (peer.dropTimer !== null) clearTimeout(peer.dropTimer)
    if (peer.agreeTimer !== null) clearTimeout(peer.agreeTimer)
    void this.#transport
      ?.sendControl(peerId, message({t: 'SESSION_END', reason: 'blocked'}))
      .catch(() => {})
    this.#transfers.peerRemoved(peerId)
    this.#peers.delete(peerId)
    this.#notice('Device blocked', `${peer.name} was not let in.`, 'info')
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

  /**
   * Sends a link or note to every connected device.
   *
   * Kept out of the transfer machinery on purpose: there is no consent step, no
   * chunking and nothing to verify, and routing a URL through the file queue
   * would mean a picker prompt for four hundred bytes.
   */
  sendText(input: string): void {
    const text = sanitizeSharedText(input, LIMITS.maxTextLength)
    if (!text || this.#status !== 'open') return

    const note: SharedText = {id: randomId(), text, from: null, at: Date.now()}
    this.#addText(note)
    for (const peer of this.#peers.values()) {
      if (!peer.approved || !peer.present || peer.isSelf) continue
      void this.#transport
        ?.sendControl(peer.id, message({t: 'TEXT_SHARE', id: note.id, text}))
        .catch(() => {})
    }
  }

  dismissText(id: string): void {
    this.#texts = this.#texts.filter(note => note.id !== id)
    this.#changed()
  }

  #addText(note: SharedText): void {
    // Newest first, and bounded — this is a scratchpad, not a history.
    if (this.#texts.some(existing => existing.id === note.id)) return
    this.#texts = [note, ...this.#texts].slice(0, 20)
    this.#changed()
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
        // `isSelf` belongs here too: nothing should ever stream to another tab
        // of this device, whatever route reached this link.
        return (
          this.#status === 'open' &&
          peer?.present === true &&
          peer.approved &&
          !peer.isSelf
        )
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
          ...(this.#selfDeviceId ? {deviceId: this.#selfDeviceId} : {}),
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
    this.#signaling = 'ok'

    this.#healthTimer = setInterval(() => {
      const now = Date.now()
      if (this.#transport?.signalingReady() === true) this.#signalingBadSince = null
      else this.#signalingBadSince ??= now

      const downFor = this.#signalingBadSince === null ? 0 : now - this.#signalingBadSince
      const next: SignalingHealth =
        downFor < SIGNALING_GRACE_MS
          ? 'ok'
          : downFor < SIGNALING_OFFLINE_MS
            ? 'retrying'
            : 'offline'

      if (next !== this.#signaling) {
        this.#signaling = next
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
    this.#signaling = 'ok'
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
    path: agreedPath(peer)
  }
}

/**
 * The single label both devices show.
 *
 * While the peer's read is still outstanding the answer stays 'unknown', which
 * the UI renders as "Connecting…" — the point is to never claim "Internet" for
 * a link that is about to be revealed as local. `agreeTimer` running out drops
 * that hold so a peer that never answers cannot leave the badge stuck.
 */
function agreedPath(peer: PeerRecord): NetworkPath {
  if (peer.path.kind === 'unknown') return peer.path
  if (peer.peerKind === null) {
    return peer.agreeTimer === null ? peer.path : UNKNOWN_PATH
  }
  return withKind(peer.path, agreeKind(peer.path.kind, peer.peerKind))
}
