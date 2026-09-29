/**
 * Keeps an unchanged snapshot object's identity.
 *
 * The UI re-renders from a fresh snapshot several times a second while anything
 * is moving. Rows are memoized on their props, which only helps if a transfer
 * that did not change hands back the *same* object — so views are rebuilt, then
 * swapped for the previous one when every field still matches.
 *
 * Fields are compared by identity, looking one level into plain objects and
 * arrays: an error view or a path is rebuilt as a new object each time, but
 * with the same contents it is the same fact.
 */
export function keepIfSame<T extends object>(previous: T | null | undefined, next: T): T {
  if (!previous) return next
  const a = previous as Record<string, unknown>
  const b = next as Record<string, unknown>
  const keys = Object.keys(b)
  if (keys.length !== Object.keys(a).length) return next
  for (const key of keys) {
    if (!sameValue(a[key], b[key])) return next
  }
  return previous
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => item === b[i])
  }
  if (isPlain(a) && isPlain(b)) {
    const keys = Object.keys(b)
    return keys.length === Object.keys(a).length && keys.every(key => a[key] === b[key])
  }
  return false
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
