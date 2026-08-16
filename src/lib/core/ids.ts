/**
 * Room credentials.
 *
 * The pairing code IS the room capability (spec §75.3): it never reaches any
 * server. What gets published to the signaling relay is a *hash* of it, and the
 * code doubles as the Trystero password that encrypts signaling payloads. So a
 * relay operator sees an opaque topic and ciphertext, and cannot join or
 * reconstruct the code. Guessing is countered by entropy (60 bits) plus the
 * explicit device-approval step in SessionManager.
 */

/** Crockford base32 — no I, L, O or U, so codes survive being read aloud. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const CODE_SYMBOLS = 12 // 12 × 5 bits = 60 bits of entropy
const GROUP = 4

export function randomCode(symbols = CODE_SYMBOLS): string {
  const bytes = crypto.getRandomValues(new Uint8Array(symbols))
  let out = ''
  // 256 is a multiple of 32, so masking the low 5 bits stays uniform.
  for (const byte of bytes) out += ALPHABET[byte & 31]
  return out
}

/** `K7XM42QW9PZT` → `K7XM-42QW-9PZT` */
export function formatCode(code: string): string {
  return (code.match(new RegExp(`.{1,${GROUP}}`, 'g')) ?? []).join('-')
}

/**
 * Accepts what a human actually types: lower case, spaces, missing dashes, and
 * the letters Crockford treats as digit look-alikes.
 */
export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V')
}

export function isValidCode(code: string): boolean {
  return (
    code.length === CODE_SYMBOLS &&
    [...code].every(char => ALPHABET.includes(char))
  )
}

/**
 * Topic published to the signaling relay. Derived from the code so the code
 * itself is never transmitted, and namespaced by appId so unrelated
 * deployments sharing a public relay cannot collide.
 */
export async function deriveRoomTopic(
  appId: string,
  code: string
): Promise<string> {
  const data = new TextEncoder().encode(`${appId}:room:${code}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

export function randomId(bytes = 8): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}
