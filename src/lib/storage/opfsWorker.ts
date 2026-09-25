/// <reference lib="webworker" />
/**
 * OPFS writer worker — one per page, serving every file being received.
 *
 * Sync access handles are the most broadly supported OPFS write path (Chrome,
 * Firefox, and Safari including iOS) and they must run off the main thread.
 * Writing here also keeps disk I/O from competing with the render loop during
 * a multi-gigabyte transfer. One worker for all files, rather than one each,
 * because a batch of a hundred photos used to start and stop a hundred workers.
 */

type WorkerRequest =
  | {id: number; op: 'open'; file: number; dir: string[]; name: string}
  | {id: number; op: 'write'; file: number; offset: number; data: ArrayBuffer; byteOffset: number; byteLength: number}
  | {id: number; op: 'flush'; file: number}
  | {id: number; op: 'finalize'; file: number}
  | {id: number; op: 'abort'; file: number}
  | {id: number; op: 'remove'; file: number}

type WorkerResponse =
  | {id: number; ok: true; file?: File}
  | {id: number; ok: false; error: string}

interface OpenFile {
  dir: FileSystemDirectoryHandle
  name: string
  handle: FileSystemFileHandle
  access: FileSystemSyncAccessHandle | null
}

const files = new Map<number, OpenFile>()

/** Walks (and creates) a directory path from the OPFS root. */
async function directory(path: string[]): Promise<FileSystemDirectoryHandle> {
  let dir = await navigator.storage.getDirectory()
  for (const name of path) dir = await dir.getDirectoryHandle(name, {create: true})
  return dir
}

/**
 * Older Safari shipped these methods returning promises before the spec settled
 * on synchronous returns. Awaiting covers both.
 */
async function closeAccess(entry: OpenFile): Promise<void> {
  const access = entry.access
  if (!access) return
  entry.access = null
  try {
    await access.flush()
  } catch {
    // A failed flush still requires the close below to release the lock.
  }
  await access.close()
}

function opened(file: number): OpenFile {
  const entry = files.get(file)
  if (!entry) throw new Error('no open file')
  return entry
}

async function handle(req: WorkerRequest): Promise<{file?: File}> {
  switch (req.op) {
    case 'open': {
      const dir = await directory(req.dir)
      const handle = await dir.getFileHandle(req.name, {create: true})
      const access = await handle.createSyncAccessHandle()
      // Start from a clean slate, whatever an earlier attempt left there.
      await access.truncate(0)
      files.set(req.file, {dir, name: req.name, handle, access})
      return {}
    }

    case 'write': {
      const {access} = opened(req.file)
      if (!access) throw new Error('file already closed')
      await access.write(new Uint8Array(req.data, req.byteOffset, req.byteLength), {at: req.offset})
      return {}
    }

    case 'flush': {
      const {access} = opened(req.file)
      if (!access) throw new Error('file already closed')
      await access.flush()
      return {}
    }

    case 'finalize': {
      const entry = opened(req.file)
      // The lock must be released before the file can be read back.
      await closeAccess(entry)
      return {file: await entry.handle.getFile()}
    }

    case 'abort':
    case 'remove': {
      const entry = files.get(req.file)
      if (!entry) return {}
      files.delete(req.file)
      await closeAccess(entry)
      await entry.dir.removeEntry(entry.name).catch(() => {})
      return {}
    }
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data
  let response: WorkerResponse
  try {
    response = {id: req.id, ok: true, ...(await handle(req))}
  } catch (err) {
    response = {id: req.id, ok: false, error: err instanceof Error ? err.message : String(err)}
  }
  self.postMessage(response)
}

// A module, so these declarations stay out of the global scope.
export {}
