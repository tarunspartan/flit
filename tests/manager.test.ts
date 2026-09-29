import {afterEach, describe, expect, it} from 'vitest'
import {CHUNK_SIZE, MAX_PARALLEL_SMALL_DOWNLOADS, SMALL_FILE_BYTES} from '../src/lib/core/config.ts'
import {HASH_ALGORITHM, message, type ControlMessage} from '../src/lib/protocol/messages.ts'
import type {PeerLink} from '../src/lib/transfer/PeerLink.ts'
import {TransferManager} from '../src/lib/transfer/TransferManager.ts'

/**
 * TransferManager against links that only record, so what the manager decides
 * to send can be read off directly.
 */
function managerWith(maxFrameBytes?: number) {
  const sent: {peerId: string; msg: ControlMessage}[] = []
  const manager = new TransferManager(
    peerId => ({
      isConnected: () => true,
      sendControl: async msg => {
        sent.push({peerId, msg})
      },
      sendChunk: async () => {},
      ...(maxFrameBytes === undefined ? {} : {maxFrameBytes: () => maxFrameBytes})
    }) satisfies PeerLink,
    {alwaysChooseLocation: false}
  )
  live.push(manager)
  return {manager, sent}
}

const live: TransferManager[] = []
afterEach(() => {
  for (const manager of live.splice(0)) manager.dispose()
})

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

let nextId = 0
function offer(size: number): ControlMessage {
  const id = `t${++nextId}`
  return message({
    t: 'TRANSFER_OFFER',
    transferId: id,
    seq: nextId,
    name: `${id}.bin`,
    size,
    mimeType: 'application/octet-stream',
    lastModified: 1,
    chunkSize: CHUNK_SIZE,
    totalChunks: Math.ceil(size / CHUNK_SIZE),
    hashAlgorithm: HASH_ALGORITHM
  })
}

function accepted(sent: {msg: ControlMessage}[]): number {
  return sent.filter(({msg}) => msg.t === 'TRANSFER_ACCEPT').length
}

describe('chunk sizing', () => {
  it('fits each chunk into a single data channel message', async () => {
    // 256 KiB plus a 16-byte header is just over the 256 KiB most browsers
    // negotiate, which would have split every chunk in two on the wire.
    const {manager, sent} = managerWith(256 * 1024)
    manager.peerReady('peer', 'Peer')
    manager.addFiles([new File([new Uint8Array(1024 * 1024)], 'big.bin')])
    await settle()

    const offered = sent.find(({msg}) => msg.t === 'TRANSFER_OFFER')?.msg
    expect(offered?.t).toBe('TRANSFER_OFFER')
    if (offered?.t !== 'TRANSFER_OFFER') return
    expect(offered.chunkSize + 16).toBeLessThanOrEqual(256 * 1024)
    expect(offered.chunkSize).toBe(255 * 1024)
  })

  it('uses the full chunk size when the link has no limit to fit', async () => {
    const {manager, sent} = managerWith()
    manager.peerReady('peer', 'Peer')
    manager.addFiles([new File([new Uint8Array(1024)], 'small.bin')])
    await settle()
    const offered = sent.find(({msg}) => msg.t === 'TRANSFER_OFFER')?.msg
    expect(offered?.t === 'TRANSFER_OFFER' && offered.chunkSize).toBe(CHUNK_SIZE)
  })
})

describe('download slots', () => {
  it('runs several small downloads side by side', async () => {
    const {manager, sent} = managerWith()
    for (let i = 0; i < 6; i++) manager.handleControl('peer', offer(64 * 1024))
    for (const transfer of manager.incoming()) manager.accept(transfer.id)
    await settle()

    expect(accepted(sent)).toBe(MAX_PARALLEL_SMALL_DOWNLOADS)
    const queued = manager.incoming().filter(transfer => transfer.queuePosition !== null)
    expect(queued.map(transfer => transfer.queuePosition)).toEqual([1, 2])
  })

  it('gives a large download the connection to itself', async () => {
    const {manager, sent} = managerWith()
    for (let i = 0; i < 3; i++) manager.handleControl('peer', offer(SMALL_FILE_BYTES + 1))
    for (const transfer of manager.incoming()) manager.accept(transfer.id)
    await settle()
    expect(accepted(sent)).toBe(1)
  })

  it('keeps acceptance order: a small file does not jump a large one', async () => {
    const {manager, sent} = managerWith()
    manager.handleControl('peer', offer(64 * 1024))
    manager.handleControl('peer', offer(SMALL_FILE_BYTES + 1))
    manager.handleControl('peer', offer(64 * 1024))
    for (const transfer of manager.incoming()) manager.accept(transfer.id)
    await settle()
    // The first small one runs; the large one waits for it; the small one
    // behind the large one waits its turn rather than slipping past.
    expect(accepted(sent)).toBe(1)
    expect(manager.incoming().map(transfer => transfer.queuePosition)).toEqual([null, 1, 2])
  })

  describe('with a save dialog', () => {
    /**
     * The first call opens a dialog that stays open until the test answers
     * it. Any call while it is open fails the way a browser fails a second
     * picker, or one opened with no click behind it.
     */
    function installPicker() {
      let answer: ((choice: 'save' | 'cancel') => void) | null = null
      let calls = 0
      Object.defineProperty(globalThis, 'showSaveFilePicker', {
        configurable: true,
        writable: true,
        value: () => {
          calls++
          if (calls > 1) return Promise.reject(new DOMException('File picker already active.', 'NotAllowedError'))
          return new Promise((resolve, reject) => {
            answer = choice =>
              choice === 'cancel'
                ? reject(new DOMException('The user aborted a request.', 'AbortError'))
                : resolve({
                    createWritable: async () => ({write: async () => {}, close: async () => {}, abort: async () => {}})
                  })
          })
        }
      })
      return {answer: (choice: 'save' | 'cancel') => answer?.(choice), calls: () => calls}
    }

    afterEach(() => {
      // @ts-expect-error removing the stub again
      delete globalThis.showSaveFilePicker
    })

    function downloadAll(count: number) {
      const {manager, sent} = managerWith()
      manager.setPreferences({alwaysChooseLocation: true})
      for (let i = 0; i < count; i++) manager.handleControl('peer', offer(64 * 1024))
      for (const transfer of manager.incoming()) manager.accept(transfer.id)
      return {manager, sent}
    }

    it('downloads nothing while the dialog is open', async () => {
      // The regression: the dialog opened for the first file and the rest,
      // refused a dialog of their own, fell back to browser storage and
      // started downloading behind it before anyone had chosen anything.
      const picker = installPicker()
      const {sent} = downloadAll(3)
      await settle()
      expect(picker.calls()).toBe(1)
      expect(accepted(sent)).toBe(0)
    })

    it('takes Cancel as the answer for the whole Download all', async () => {
      const picker = installPicker()
      const {manager, sent} = downloadAll(3)
      await settle()
      picker.answer('cancel')
      await settle()
      expect(accepted(sent)).toBe(0)
      // Every Download button back, nothing still queued to start later.
      expect(manager.incoming().map(transfer => [transfer.state, transfer.queuePosition])).toEqual([
        ['WAITING_FOR_ACCEPT', null],
        ['WAITING_FOR_ACCEPT', null],
        ['WAITING_FOR_ACCEPT', null]
      ])
    })

    it('asks for files that were already waiting when the setting was turned on', async () => {
      const picker = installPicker()
      const {manager, sent} = managerWith()
      manager.handleControl('peer', offer(64 * 1024))
      manager.setPreferences({alwaysChooseLocation: true})
      manager.accept(manager.incoming()[0]!.id)
      await settle()
      expect(picker.calls()).toBe(1)
      expect(accepted(sent)).toBe(0)
    })

    it('starts the rest once a location is chosen', async () => {
      const picker = installPicker()
      const {sent} = downloadAll(3)
      await settle()
      picker.answer('save')
      await settle()
      expect(accepted(sent)).toBe(3)
    })
  })

  it('answers a repeated offer instead of listing the file twice', async () => {
    const {manager, sent} = managerWith()
    const first = offer(1024)
    manager.handleControl('peer', first)
    manager.reject(manager.incoming()[0]!.id)
    await settle()
    sent.length = 0

    manager.handleControl('peer', first)
    await settle()
    expect(manager.incoming()).toHaveLength(1)
    expect(sent.map(({msg}) => msg.t)).toEqual(['TRANSFER_REJECT'])
  })
})
