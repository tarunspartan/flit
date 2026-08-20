/**
 * Incoming filenames are hostile input (spec §20, §75.2). They arrive from
 * another device and end up in a save dialog, so they get normalized before
 * they are shown anywhere or handed to a filesystem API.
 */

// Reserved on Windows regardless of extension.
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i
// C0/C1 control characters plus the characters Windows forbids.
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/g
const MAX_LENGTH = 255

export function sanitizeFilename(input: unknown, fallback = 'file'): string {
  if (typeof input !== 'string') return fallback

  // Order matters: separators must be split off *before* illegal characters
  // are replaced, or `../../etc/passwd` collapses into one long filename
  // instead of its basename.
  let name = input.normalize('NFC')

  // Unicode direction overrides can disguise an extension (`evil<RLO>gpj.exe`).
  name = name.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')

  // Strip every path component: `../../etc/passwd` and `C:\x\y` both collapse
  // to their basename, so an incoming name can never escape the destination.
  name = name.split(/[/\\]/).pop() ?? ''

  name = name.replace(ILLEGAL, '_')

  // A leading dot hides the file; trailing dots and spaces are dropped by Windows.
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '').trim()

  if (name === '' || RESERVED.test(name)) name = fallback
  return truncateFilename(name, MAX_LENGTH)
}

/** Truncates on byte length while keeping the extension intact. */
function truncateFilename(name: string, maxBytes = MAX_LENGTH): string {
  const encoder = new TextEncoder()
  if (encoder.encode(name).byteLength <= maxBytes) return name

  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot, dot + 24) : ''
  const extBytes = encoder.encode(ext).byteLength
  const budget = Math.max(1, maxBytes - extBytes)

  let stem = dot > 0 ? name.slice(0, dot) : name
  while (encoder.encode(stem).byteLength > budget) {
    // Slice by code point so we never split a surrogate pair.
    stem = [...stem].slice(0, -1).join('')
  }
  return `${stem}${ext}` || 'file'
}

/** `report.pdf` → `report (2).pdf` when the name is already taken. */
export function uniqueFilename(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; n < 10_000; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!taken.has(candidate)) return candidate
  }
  return `${stem} (${Date.now()})${ext}`
}

/**
 * Folder transfers carry a relative path. Every segment is sanitized and any
 * `..`/absolute prefix is dropped, so the result always stays inside the
 * destination directory.
 */
export function sanitizeRelativePath(input: unknown): string[] {
  if (typeof input !== 'string' || input === '') return []
  return input
    .split(/[/\\]/)
    .filter(segment => segment !== '' && segment !== '.' && segment !== '..')
    .map(segment => sanitizeFilename(segment, 'folder'))
    .slice(0, 32)
}
