/// <reference lib="webworker" />
/**
 * OPFS writer worker.
 *
 * Sync access handles are the most broadly supported OPFS write path (Chrome,
 * Firefox, and Safari including iOS) and they must run off the main thread.
 * Writing here also keeps disk I/O from competing with the render loop during
 * a multi-gigabyte transfer.
 */

export const OPFS_DIR = 'flit-incoming'

type Request =
  | {id: number; op: 'open'; name: string}
  | {id: number; op: 'write'; offset: number; data: ArrayBuffer}
  | {id: number; op: 'flush'}
  | {id: number; op: 'finalize'}
  | {id: number; op: 'abort'}
  | {id: number; op: 'purge'}

type Response =
  | {id: number; ok: true; file?: File}
  | {id: number; ok: false; error: string}

let dir: FileSystemDirectoryHandle | null = null
let fileHandle: FileSystemFileHandle | null = null
let access: FileSystemSyncAccessHandle | null = null
let openName = ''

async function getDir(): Promise<FileSystemDirectoryHandle> {
  dir ??= await (await navigator.storage.getDirectory()).getDirectoryHandle(OPFS_DIR, {
    create: true
  })
  return dir
}

/**
 * Older Safari shipped these methods returning promises before the spec settled
 * on synchronous returns. Awaiting covers both.
 */
async function closeAccess(): Promise<void> {
  if (!access) return
  const handle = access
  access = null
  try {
    await handle.flush()
  } catch {
    // A failed flush still requires the close below to release the lock.
  }
  await handle.close()
}

async function handle(req: Request): Promise<{file?: File}> {
  switch (req.op) {
    case 'open': {
      await closeAccess()
      const directory = await getDir()
      openName = req.name
      fileHandle = await directory.getFileHandle(openName, {create: true})
      access = await fileHandle.createSyncAccessHandle()
      // Start from a clean slate: a retried transfer reuses the same name.
      await access.truncate(0)
      return {}
    }

    case 'write': {
      if (!access) throw new Error('no open file')
      await access.write(new Uint8Array(req.data), {at: req.offset})
      return {}
    }

    case 'flush': {
      if (!access) throw new Error('no open file')
      await access.flush()
      return {}
    }

    case 'finalize': {
      if (!fileHandle) throw new Error('no open file')
      // The lock must be released before the file can be read back.
      await closeAccess()
      return {file: await fileHandle.getFile()}
    }

    case 'abort': {
      await closeAccess()
      if (openName) {
        const directory = await getDir()
        await directory.removeEntry(openName).catch(() => {})
      }
      fileHandle = null
      openName = ''
      return {}
    }

    case 'purge': {
      // Removes leftovers from a previous session that ended abruptly.
      await closeAccess()
      const root = await navigator.storage.getDirectory()
      await root.removeEntry(OPFS_DIR, {recursive: true}).catch(() => {})
      dir = null
      fileHandle = null
      openName = ''
      return {}
    }
  }
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const req = event.data
  try {
    const result = await handle(req)
    const response: Response = {id: req.id, ok: true, ...result}
    self.postMessage(response)
  } catch (err) {
    const response: Response = {
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
    self.postMessage(response)
  }
}
