import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./app', () => ({
  MAX_FILE_BYTES: 50 * 1024 * 1024,
  notify: vi.fn(),
  runImport: vi.fn().mockResolvedValue(undefined),
}))

import { notify, runImport } from './app'
import { registerLaunchQueueConsumer } from './launch-queue'

const notifyMock = vi.mocked(notify)
const runImportMock = vi.mocked(runImport)

function makeHandle(file: File): FileSystemFileHandle {
  return { getFile: vi.fn().mockResolvedValue(file) } as unknown as FileSystemFileHandle
}

function makeFile(name: string, size: number): File {
  return Object.defineProperty(new File([], name), 'size', { value: size }) as File
}

type MockLaunchQueue = {
  setConsumer: ReturnType<typeof vi.fn>
  invokeConsumer: (params: LaunchParams) => Promise<void>
}

function installMockLaunchQueue(): MockLaunchQueue {
  let capturedConsumer: ((p: LaunchParams) => Promise<void>) | undefined
  const lq: MockLaunchQueue = {
    setConsumer: vi.fn((consumer: (p: LaunchParams) => Promise<void>) => {
      capturedConsumer = consumer
    }),
    invokeConsumer: async (params: LaunchParams) => {
      if (!capturedConsumer) throw new Error('setConsumer was not called')
      await capturedConsumer(params)
    },
  }
  Object.defineProperty(window, 'launchQueue', { value: lq, configurable: true })
  return lq
}

describe('registerLaunchQueueConsumer', () => {
  beforeEach(() => {
    notifyMock.mockClear()
    runImportMock.mockClear()
  })

  afterEach(() => {
    try {
      delete (window as { launchQueue?: unknown }).launchQueue
    } catch {
      Object.defineProperty(window, 'launchQueue', { value: undefined, configurable: true })
    }
  })

  it('does nothing when launchQueue is absent', () => {
    expect('launchQueue' in window).toBe(false)
    registerLaunchQueueConsumer()
    expect(notifyMock).not.toHaveBeenCalled()
    expect(runImportMock).not.toHaveBeenCalled()
  })

  it('calls setConsumer when launchQueue is present', () => {
    const lq = installMockLaunchQueue()
    registerLaunchQueueConsumer()
    expect(lq.setConsumer).toHaveBeenCalledOnce()
  })

  it('calls runImport for each valid file handle', async () => {
    const lq = installMockLaunchQueue()
    registerLaunchQueueConsumer()

    const fileA = makeFile('a.csv', 100)
    const fileB = makeFile('b.csv', 200)
    await lq.invokeConsumer({ files: [makeHandle(fileA), makeHandle(fileB)] })

    expect(runImportMock).toHaveBeenCalledTimes(2)
    expect(runImportMock).toHaveBeenCalledWith(fileA)
    expect(runImportMock).toHaveBeenCalledWith(fileB)
  })

  it('notifies and skips oversized files', async () => {
    const lq = installMockLaunchQueue()
    registerLaunchQueueConsumer()

    const big = makeFile('huge.csv', 60 * 1024 * 1024)
    await lq.invokeConsumer({ files: [makeHandle(big)] })

    expect(notifyMock).toHaveBeenCalledOnce()
    expect(notifyMock.mock.calls[0][0]).toMatch(/too large/)
    expect(notifyMock.mock.calls[0][1]).toBe(true)
    expect(runImportMock).not.toHaveBeenCalled()
  })

  it('logs and skips handles that fail getFile()', async () => {
    const lq = installMockLaunchQueue()
    registerLaunchQueueConsumer()

    const badHandle = {
      getFile: vi.fn().mockRejectedValue(new Error('access denied')),
    } as unknown as FileSystemFileHandle
    const goodFile = makeFile('ok.csv', 100)

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await lq.invokeConsumer({ files: [badHandle, makeHandle(goodFile)] })
    errorSpy.mockRestore()

    expect(runImportMock).toHaveBeenCalledOnce()
    expect(runImportMock).toHaveBeenCalledWith(goodFile)
  })

  it('processes files sequentially, not in parallel', async () => {
    const lq = installMockLaunchQueue()
    registerLaunchQueueConsumer()

    const order: number[] = []
    runImportMock.mockImplementation(async (_file: File) => {
      order.push(order.length)
      await Promise.resolve()
    })

    const handles = [makeFile('1.csv', 1), makeFile('2.csv', 1), makeFile('3.csv', 1)].map(
      makeHandle,
    )
    await lq.invokeConsumer({ files: handles })

    expect(order).toEqual([0, 1, 2])
  })
})
