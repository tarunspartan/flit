/**
 * A friendly device label (spec §66.3). Derived locally from the user agent,
 * editable by the user, and never sent anywhere except to the paired peer over
 * the encrypted data channel.
 */
const STORAGE_KEY = 'flit.deviceName'

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

/** Control characters and bidi overrides — a peer name is untrusted display text. */
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

export function sanitizeDeviceName(input: unknown): string {
  if (typeof input !== 'string') return 'Unknown device'
  const clean = input.replace(UNSAFE_TEXT, '').trim().slice(0, 32)
  return clean || 'Unknown device'
}
