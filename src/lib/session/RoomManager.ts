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
