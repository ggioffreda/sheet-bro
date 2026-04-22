import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('loadSqlJs', () => {
  const initMock = vi.fn()

  beforeEach(() => {
    initMock.mockReset()
    initMock.mockImplementation((opts: { locateFile: () => string }) => {
      // Simulate sql.js's default export shape — it's an init function that
      // returns a Promise<SqlJsStatic>. We return a tagged object that lets
      // the test verify the locateFile plumbing.
      return Promise.resolve({ Database: class {}, _locate: opts.locateFile() })
    })
    vi.doMock('sql.js', () => ({ default: initMock }))
    vi.doMock('sql.js/dist/sql-wasm.wasm?url', () => ({ default: '/fake-wasm-url' }))
    // Force sqljs.ts to re-evaluate so its module-level `cached` resets.
    vi.resetModules()
  })

  afterEach(() => {
    vi.doUnmock('sql.js')
    vi.doUnmock('sql.js/dist/sql-wasm.wasm?url')
    vi.resetModules()
  })

  it('dynamically imports sql.js and wires locateFile to the ?url asset', async () => {
    const { loadSqlJs } = await import('./sqljs')
    const SQL = (await loadSqlJs()) as unknown as { _locate: string }
    expect(SQL._locate).toBe('/fake-wasm-url')
    expect(initMock).toHaveBeenCalledTimes(1)
  })

  it('memoizes — two calls return the same promise and only invoke init once', async () => {
    const { loadSqlJs } = await import('./sqljs')
    const first = loadSqlJs()
    const second = loadSqlJs()
    expect(first).toBe(second)
    await first
    expect(initMock).toHaveBeenCalledTimes(1)
  })

  it('propagates initSqlJs rejection with the original error', async () => {
    const err = new Error('wasm init blew up')
    initMock.mockImplementation(() => Promise.reject(err))
    const { loadSqlJs } = await import('./sqljs')
    await expect(loadSqlJs()).rejects.toBe(err)
  })

  it('after a failed load, subsequent calls return the same rejected promise (poisoning is intentional)', async () => {
    // WASM load failures are not transient; retrying hides the real
    // diagnostic. If a future change wants retry semantics, it must flip
    // this assertion explicitly.
    const err = new Error('boom')
    initMock.mockImplementation(() => Promise.reject(err))
    const { loadSqlJs } = await import('./sqljs')
    const first = loadSqlJs()
    const second = loadSqlJs()
    expect(first).toBe(second)
    await expect(first).rejects.toBe(err)
    await expect(second).rejects.toBe(err)
    expect(initMock).toHaveBeenCalledTimes(1)
  })
})
