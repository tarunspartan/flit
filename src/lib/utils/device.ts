/**
 * A friendly device label (spec §66.3). Derived locally from the user agent,
 * editable by the user, and never sent anywhere except to the paired peer over
 * the encrypted data channel.
 */
import {randomId} from '../core/ids.ts'

const STORAGE_KEY = 'flit.deviceName'
const ID_KEY = 'flit.deviceId'

export type DeviceKind = 'phone' | 'tablet' | 'laptop' | 'desktop'

export function guessDeviceName(): string {
  const ua = navigator.userAgent
  const isTouchMac =
    /Macintosh/.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1

  if (/iPhone/.test(ua)) return 'iPhone'
  // iPadOS reports itself as a Mac; touch points give it away.
  if (/iPad/.test(ua) || isTouchMac) return 'iPad'
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet'
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'Windows PC'
  if (/CrOS/.test(ua)) return 'Chromebook'
  if (/Linux/.test(ua)) return 'Linux PC'
  return 'This device'
}

export function guessDeviceKind(): DeviceKind {
  const name = guessDeviceName()
  if (name === 'iPhone' || name === 'Android phone') return 'phone'
  if (name === 'iPad' || name === 'Android tablet') return 'tablet'
  if (name === 'Mac' || name === 'Chromebook') return 'laptop'
  return 'desktop'
}

export function loadDeviceName(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) return stored.slice(0, 32)
  } catch {
    // Private-mode Safari throws on localStorage; the guess is a fine default.
  }
  return guessDeviceName()
}

export function saveDeviceName(name: string): string {
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, 32) || guessDeviceName()
  try {
    localStorage.setItem(STORAGE_KEY, clean)
  } catch {
    // Non-fatal: the name simply won't persist across reloads.
  }
  return clean
}

/**
 * A stable id for this browser profile, minted once and kept.
 *
 * Trystero's selfId is regenerated on every page load, so two tabs of one phone
 * arrive as two unrelated devices — scan a code twice and the room fills with
 * duplicates of you, each one offered its own copy of every file. localStorage
 * is shared across tabs of an origin, which is exactly the scope wanted here:
 * same browser profile, same device. Two different browsers are two different
 * devices as far as this goes, which is the honest answer — they share no
 * storage and nothing links them.
 *
 * Local only, and never sent anywhere but to peers already holding the room
 * code, over the encrypted channel.
 */
export function loadDeviceId(): string | null {
  try {
    const stored = localStorage.getItem(ID_KEY)
    if (stored !== null && /^[0-9a-f]{16,64}$/.test(stored)) return stored
    const minted = randomId()
    localStorage.setItem(ID_KEY, minted)
    return minted
  } catch {
    // Private-mode Safari throws. Without a stable id nothing dedupes, which is
    // the behaviour that existed before this — degraded, not broken.
    return null
  }
}

/** Control characters and bidi overrides — a peer name is untrusted display text. */
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

export function sanitizeDeviceName(input: unknown): string {
  if (typeof input !== 'string') return 'Unknown device'
  const clean = input.replace(UNSAFE_TEXT, '').trim().slice(0, 32)
  return clean || 'Unknown device'
}
