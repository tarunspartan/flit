/**
 * Users never see `RTCError 701` (spec §26). Everything that can fail carries a
 * code plus a sentence a non-technical person can act on.
 */
import {MAX_PEERS} from './config.ts'

export type ErrorCode =
  | 'invalid-code'
  | 'room-full'
  | 'room-expired'
  | 'pairing-timeout'
  | 'connection-failed'
  | 'connection-lost'
  | 'peer-blocked'
  | 'protocol-version'
  | 'protocol-violation'
  | 'transfer-rejected'
  | 'transfer-cancelled'
  | 'transfer-stalled'
  | 'file-unreadable'
  | 'file-changed'
  | 'too-large'
  | 'too-many-files'
  | 'storage-unavailable'
  | 'storage-full'
  | 'finalize-failed'
  | 'integrity-failed'
  | 'resume-mismatch'
  | 'unsupported-browser'
  | 'unknown'

export class AppError extends Error {
  readonly code: ErrorCode
  readonly detail?: string

  constructor(code: ErrorCode, detail?: string, options?: {cause?: unknown}) {
    super(detail ? `${code}: ${detail}` : code, options)
    this.name = 'AppError'
    this.code = code
    this.detail = detail
  }
}

type Friendly = {title: string; message: string; retryable: boolean}

const MESSAGES: Record<ErrorCode, Friendly> = {
  'invalid-code': {
    title: "That code doesn't look right",
    message: 'Check the code on the other device and try again.',
    retryable: true
  },
  'room-full': {
    title: 'This code is full',
    message: `Up to ${MAX_PEERS} devices can be connected at once. Disconnect one, or use a different code.`,
    retryable: false
  },
  'room-expired': {
    title: 'This code has expired',
    message: 'Reload the page to get a fresh code, then scan it again.',
    retryable: false
  },
  'pairing-timeout': {
    title: "Couldn't find the other device",
    message: 'Make sure the code is still open on the other device, then try again.',
    retryable: true
  },
  'connection-failed': {
    title: "Couldn't connect to the other device",
    message:
      'Check that both devices are online and try again. Some corporate or public networks block direct connections.',
    retryable: true
  },
  'connection-lost': {
    title: 'The connection was interrupted',
    message: 'We tried to reconnect but could not reach the other device.',
    retryable: true
  },
  'peer-blocked': {
    title: 'Device blocked',
    message: 'You disconnected this device. Reload the page to start over.',
    retryable: false
  },
  'protocol-version': {
    title: 'The other device is running a different version',
    message: 'Reload the page on both devices so they run the same version.',
    retryable: false
  },
  'protocol-violation': {
    title: 'Unexpected data from the other device',
    message: 'The transfer was stopped as a precaution. Reconnect and try again.',
    retryable: true
  },
  'transfer-rejected': {
    title: 'Transfer declined',
    message: 'The other device declined this file.',
    retryable: true
  },
  'transfer-cancelled': {
    title: 'Transfer cancelled',
    message: 'This transfer was cancelled.',
    retryable: true
  },
  'transfer-stalled': {
    title: 'The transfer stopped responding',
    message: 'Nothing arrived for a while. Check both devices are awake and retry.',
    retryable: true
  },
  'file-unreadable': {
    title: "Couldn't read the file",
    message: 'It may have been moved, renamed, or deleted since you selected it.',
    retryable: false
  },
  'file-changed': {
    title: 'The file changed while sending',
    message: 'Select the file again to start a fresh transfer.',
    retryable: false
  },
  'too-large': {
    title: 'That file is too big to send',
    message: 'Try a smaller one.',
    retryable: false
  },
  'too-many-files': {
    title: 'Too many files at once',
    message: 'Send them in smaller batches.',
    retryable: false
  },
  'storage-unavailable': {
    title: "This browser can't save the file safely",
    message:
      'It lacks the storage APIs needed for large transfers. Try Chrome, Edge, Firefox, or a recent Safari.',
    retryable: false
  },
  'storage-full': {
    title: 'Not enough storage to finish',
    message: 'Free up space on this device and retry the transfer.',
    retryable: true
  },
  'finalize-failed': {
    title: 'Transfer received, but the file could not be saved',
    message: 'All the data arrived — writing it to your device failed. Retry to save it again.',
    retryable: true
  },
  'integrity-failed': {
    title: 'File verification failed',
    message: "The received file doesn't match the original, so it was not saved. Please retry.",
    retryable: true
  },
  'resume-mismatch': {
    title: "Couldn't resume this transfer",
    message: 'The file changed since the transfer started. Starting over is required.',
    retryable: true
  },
  'unsupported-browser': {
    title: 'This browser is missing something we need',
    message: 'WebRTC data channels are unavailable here. Try a current Chrome, Edge, Safari, or Firefox.',
    retryable: false
  },
  unknown: {
    title: 'Something went wrong',
    message: 'Please try again.',
    retryable: true
  }
}

export function friendly(error: unknown): Friendly {
  if (error instanceof AppError) return MESSAGES[error.code]
  return MESSAGES.unknown
}

export function codeOf(error: unknown): ErrorCode {
  return error instanceof AppError ? error.code : 'unknown'
}

export function toAppError(error: unknown, fallback: ErrorCode = 'unknown'): AppError {
  if (error instanceof AppError) return error
  const detail = error instanceof Error ? error.message : String(error)
  return new AppError(fallback, detail, {cause: error})
}
