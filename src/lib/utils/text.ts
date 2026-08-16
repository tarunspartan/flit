/**
 * Shared text — links and short notes — treated with the same suspicion as a
 * filename. React escapes markup on its own; what it does not stop is the
 * invisible run of characters that lets text claim to be something it isn't.
 */

/**
 * Control and bidi-override characters. Tab, newline and carriage return are
 * deliberately spared: a pasted note has line breaks in it and they are safe.
 */
const UNSAFE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

export function sanitizeSharedText(input: unknown, max: number): string {
  if (typeof input !== 'string') return ''
  return input.replace(UNSAFE, '').slice(0, max).trim()
}

/**
 * The message as a link, but only when the *whole* message is one.
 *
 * Deliberately not a linkifier. Finding URLs inside a block of text and making
 * them clickable is how a note that reads as harmless ends up carrying a
 * disguised destination; requiring the entire message to parse means what is
 * shown and what is opened are the same string. Anything but http(s) — data:,
 * javascript:, file: — is not a link here.
 */
export function asLink(text: string): string | null {
  const trimmed = text.trim()
  if (/\s/.test(trimmed)) return null
  try {
    const url = new URL(trimmed)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}
