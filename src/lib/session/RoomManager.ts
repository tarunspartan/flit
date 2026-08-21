import {LIMITS} from '../core/config.ts'
import {AppError} from '../core/errors.ts'
import {formatCode, isValidCode, normalizeCode, randomCode} from '../core/ids.ts'

/**
 * Room lifecycle and expiry (spec §8, §85.1). Rooms are temporary by
 * construction: nothing about them is stored server-side, and the code stops
 * working once the TTL passes.
 */

export type RoomRole = 'host' | 'guest'

export interface Room {
  code: string
  display: string
  role: RoomRole
  createdAt: number
  expiresAt: number
}

/** Local throttle on repeated wrong codes (§75.2 "room-code guessing"). */
class JoinThrottle {
  #attempts: number[] = []

  check(now = Date.now()): void {
    this.#attempts = this.#attempts.filter(at => now - at < LIMITS.joinAttemptWindowMs)
    if (this.#attempts.length >= LIMITS.maxJoinAttempts) {
      throw new AppError('invalid-code', 'too many attempts, wait a moment')
    }
  }

  record(now = Date.now()): void {
    this.#attempts.push(now)
  }
}

export class RoomManager {
  #room: Room | null = null
  #throttle = new JoinThrottle()

  get current(): Room | null {
    return this.#room
  }

  create(): Room {
    const code = randomCode()
    const createdAt = Date.now()
    this.#room = {
      code,
      display: formatCode(code),
      role: 'host',
      createdAt,
      expiresAt: createdAt + LIMITS.roomLifetimeMs
    }
    return this.#room
  }

  join(input: string): Room {
    this.#throttle.check()
    const code = normalizeCode(input)
    if (!isValidCode(code)) {
      this.#throttle.record()
      throw new AppError('invalid-code', `got ${code.length} symbols, expected 12`)
    }
    const createdAt = Date.now()
    this.#room = {
      code,
      display: formatCode(code),
      role: 'guest',
      createdAt,
      expiresAt: createdAt + LIMITS.roomLifetimeMs
    }
    return this.#room
  }

  /**
   * Restores the room this tab was already in, after a reload.
   *
   * Deliberately not `join`: joining mints a fresh lifetime, counts against the
   * wrong-code throttle, and turns a host into a guest. A reload is none of
   * those things — it is the same room, the same role, the same expiry.
   */
  resume(saved: SavedRoom): Room | null {
    const code = normalizeCode(saved.code)
    if (!isValidCode(code)) return null
    const expiresAt = saved.createdAt + LIMITS.roomLifetimeMs
    if (Date.now() >= expiresAt) return null
    this.#room = {code, display: formatCode(code), role: saved.role, createdAt: saved.createdAt, expiresAt}
    return this.#room
  }

  isExpired(now = Date.now()): boolean {
    return this.#room !== null && now >= this.#room.expiresAt
  }

  clear(): void {
    this.#room = null
  }

  /**
   * Link that carries the code in the URL *fragment*, which browsers never send
   * to a server — so the capability stays on the two devices (§75.3).
   */
  shareUrl(origin = location.origin + location.pathname): string | null {
    if (!this.#room) return null
    return `${origin}#c=${this.#room.code}`
  }
}

/** Reads a pairing code from a scanned link. */
export function codeFromUrl(hash = location.hash): string | null {
  const match = /[#&]c=([0-9A-Za-z-]{12,20})/.exec(hash)
  if (!match?.[1]) return null
  const code = normalizeCode(match[1])
  return isValidCode(code) ? code : null
}

export interface SavedRoom {
  code: string
  role: RoomRole
  createdAt: number
}

/**
 * The room this tab is in, kept across a reload.
 *
 * sessionStorage rather than localStorage on purpose: it survives a refresh —
 * including the one that applies an app update — but not closing the tab, which
 * is exactly how long a room should outlive the page. Without it every reload
 * minted a new code and silently abandoned the device on the old one, so
 * updating the app looked like a connection failure.
 */
const ROOM_KEY = 'flit.room'

export function saveRoom(room: Room | null): void {
  try {
    if (!room) sessionStorage.removeItem(ROOM_KEY)
    else {
      const saved: SavedRoom = {code: room.code, role: room.role, createdAt: room.createdAt}
      sessionStorage.setItem(ROOM_KEY, JSON.stringify(saved))
    }
  } catch {
    // Private mode and disabled storage both throw. A reload then behaves as
    // it used to, which is a lost pairing, not a broken app.
  }
}

export function loadRoom(): SavedRoom | null {
  try {
    const raw = sessionStorage.getItem(ROOM_KEY)
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return null
    const {code, role, createdAt} = value as Record<string, unknown>
    if (typeof code !== 'string' || typeof createdAt !== 'number') return null
    if (role !== 'host' && role !== 'guest') return null
    return {code, role, createdAt}
  } catch {
    return null
  }
}
