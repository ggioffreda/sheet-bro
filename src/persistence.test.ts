import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'

import {
  clearAllRecords,
  clearKey,
  clearTabIdentity,
  closeStorage,
  deleteRecord,
  deleteRecordById,
  getAllTabMeta,
  getTabName,
  initStorage,
  initTabName,
  loadSnapshot,
  saveSnapshot,
  setTabName,
  type StorageContext,
} from './persistence'

// happy-dom provides sessionStorage but not IndexedDB; fake-indexeddb/auto installs
// a global indexedDB. We reset both between tests so state doesn't leak.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  sessionStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('initStorage', () => {
  it('creates a stable tab id and key across re-init within the same tab', async () => {
    const a = await initStorage()
    const b = await initStorage()
    expect(a.tabId).toBe(b.tabId)
    // Keys are CryptoKey objects; identity isn't guaranteed across importKey
    // calls, so compare behaviour: both should decrypt each other's output.
    const snap = { hello: 'world' }
    await saveSnapshot(a, snap)
    expect(await loadSnapshot(b)).toEqual(snap)
    closeStorage(a)
    closeStorage(b)
  })

  it('assigns a new tab id when sessionStorage is cleared (simulating a new tab)', async () => {
    const a = await initStorage()
    const firstId = a.tabId
    closeStorage(a)
    sessionStorage.clear()
    const b = await initStorage()
    expect(b.tabId).not.toBe(firstId)
    closeStorage(b)
  })

  it('clears a legacy sessionStorage enc-key on first init (one-shot migration)', async () => {
    sessionStorage.setItem('sheet-bro:enc-key', 'legacy-bytes')
    const ctx = await initStorage()
    expect(sessionStorage.getItem('sheet-bro:enc-key')).toBeNull()
    closeStorage(ctx)
  })

  it('mints a non-extractable AES-GCM key', async () => {
    const ctx = await initStorage()
    expect(ctx.key.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', ctx.key)).rejects.toBeDefined()
    closeStorage(ctx)
  })
})

describe('saveSnapshot / loadSnapshot', () => {
  it('round-trips a complex snapshot through AES-GCM + IndexedDB', async () => {
    const ctx = await initStorage()
    const snap = {
      sheets: { sheet1: { id: 'sheet1', name: 'S', cellData: { 0: { 0: { v: 42 } } } } },
      meta: { x: [1, 2, 3], y: 'hi', z: null },
    }
    await saveSnapshot(ctx, snap)
    expect(await loadSnapshot(ctx)).toEqual(snap)
    closeStorage(ctx)
  })

  it('returns null when no record exists for this tab', async () => {
    const ctx = await initStorage()
    expect(await loadSnapshot(ctx)).toBeNull()
    closeStorage(ctx)
  })

  it('uses a distinct random IV for each save', async () => {
    const ctx = await initStorage()
    const reads: Uint8Array[] = []
    for (let i = 0; i < 3; i++) {
      await saveSnapshot(ctx, { i })
      const record = await readRaw(ctx)
      reads.push(new Uint8Array(record.iv))
    }
    expect(reads[0].length).toBe(12) // AES-GCM 96-bit IV
    expect(bytesEq(reads[0], reads[1])).toBe(false)
    expect(bytesEq(reads[1], reads[2])).toBe(false)
    expect(bytesEq(reads[0], reads[2])).toBe(false)
    closeStorage(ctx)
  })

  it('updates tab_metadata.lastSeen when a tab name is set in sessionStorage', async () => {
    const ctx = await initStorage()
    sessionStorage.setItem('sheet-bro:tab-name', 'My-Tab')
    await saveSnapshot(ctx, { ok: true })
    // tab_metadata entry must now exist with the name from sessionStorage.
    const meta = await getTabName(ctx.db, ctx.tabId)
    expect(meta).toBe('My-Tab')
    closeStorage(ctx)
  })

  it('overwrites the prior record rather than appending', async () => {
    const ctx = await initStorage()
    await saveSnapshot(ctx, { version: 1 })
    await saveSnapshot(ctx, { version: 2 })
    expect(await loadSnapshot(ctx)).toEqual({ version: 2 })
    closeStorage(ctx)
  })

  it('throws the auth-failed message when ciphertext is tampered with', async () => {
    const ctx = await initStorage()
    await saveSnapshot(ctx, { secret: 'abc' })
    const record = await readRaw(ctx)
    const bytes = new Uint8Array(record.ciphertext as ArrayBuffer)
    bytes[0] ^= 0xff
    await writeRaw(ctx, { ...record, ciphertext: bytes.buffer })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(loadSnapshot(ctx)).rejects.toThrow(/authentication failed/)
    warnSpy.mockRestore()
    closeStorage(ctx)
  })

  it('throws the auth-failed message when the IV is tampered with', async () => {
    const ctx = await initStorage()
    await saveSnapshot(ctx, { secret: 'abc' })
    const record = await readRaw(ctx)
    const iv = new Uint8Array(record.iv)
    iv[0] ^= 0xff
    await writeRaw(ctx, { ...record, iv })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(loadSnapshot(ctx)).rejects.toThrow(/authentication failed/)
    warnSpy.mockRestore()
    closeStorage(ctx)
  })

  it('re-wraps a non-OperationError from subtle.decrypt as "unexpected error"', async () => {
    // Regression guard: any non-AES-GCM-tag error still goes through the
    // generic branch so we don't leak raw WebCrypto error text to callers.
    const ctx = await initStorage()
    await saveSnapshot(ctx, { ok: true })
    const spy = vi.spyOn(crypto.subtle, 'decrypt').mockRejectedValueOnce(
      Object.assign(new Error('boom'), { name: 'TypeError' }),
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(loadSnapshot(ctx)).rejects.toThrow(/unexpected error during decryption/)
    spy.mockRestore()
    warnSpy.mockRestore()
    closeStorage(ctx)
  })

  it('cannot be decrypted by a fresh (different) key', async () => {
    const ctxA = await initStorage()
    await saveSnapshot(ctxA, { mine: true })
    closeStorage(ctxA)
    // Simulate a different tab's key: wipe the key row for A's tabId and
    // re-init under the same tabId to mint a new one.
    await new Promise<void>((resolve, reject) => {
      const reopen = indexedDB.open('sheet-bro')
      reopen.onsuccess = () => {
        const db = reopen.result
        const tx = db.transaction('tab_keys', 'readwrite')
        tx.objectStore('tab_keys').delete(ctxA.tabId)
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => { db.close(); reject(tx.error) }
      }
      reopen.onerror = () => reject(reopen.error)
    })
    const ctxB = await initStorage()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(loadSnapshot(ctxB)).rejects.toThrow(/authentication failed/)
    warnSpy.mockRestore()
    closeStorage(ctxB)
  })

  it('throws "invalid IV" when the stored IV is the wrong length', async () => {
    const ctx = await initStorage()
    await saveSnapshot(ctx, { ok: true })
    const record = await readRaw(ctx)
    await writeRaw(ctx, { ...record, iv: new Uint8Array(8) })
    await expect(loadSnapshot(ctx)).rejects.toThrow(/invalid IV/)
    closeStorage(ctx)
  })

  it('throws "invalid IV" when the stored IV is not a Uint8Array', async () => {
    const ctx = await initStorage()
    await saveSnapshot(ctx, { ok: true })
    const record = await readRaw(ctx)
    await writeRaw(ctx, { ...record, iv: 'garbage' as unknown as Uint8Array })
    await expect(loadSnapshot(ctx)).rejects.toThrow(/invalid IV/)
    closeStorage(ctx)
  })
})

describe('clearKey', () => {
  it('removes the key row for this tab from IndexedDB', async () => {
    const ctx = await initStorage()
    await clearKey(ctx)
    const raw = await new Promise<unknown>((resolve, reject) => {
      const tx = ctx.db.transaction('tab_keys', 'readonly')
      const req = tx.objectStore('tab_keys').get(ctx.tabId)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    expect(raw).toBeUndefined()
    closeStorage(ctx)
  })

  it('causes a subsequent initStorage to generate a fresh key that cannot decrypt prior records', async () => {
    const ctxA = await initStorage()
    await saveSnapshot(ctxA, { sealed: true })
    await clearKey(ctxA)
    closeStorage(ctxA)
    const ctxB = await initStorage()
    // tabId survives (still in sessionStorage), so loadSnapshot targets the
    // existing record — but under a new key. AES-GCM auth must reject it.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(loadSnapshot(ctxB)).rejects.toThrow(/authentication failed/)
    warnSpy.mockRestore()
    closeStorage(ctxB)
  })
})

describe('pruneExpired', () => {
  it('removes records older than 24h on init', async () => {
    const ctx = await initStorage()
    await saveSnapshot(ctx, { note: 'fresh' })
    // Backdate the record to 25 hours ago.
    const record = await readRaw(ctx)
    await writeRaw(ctx, {
      ...record,
      lastSeen: Date.now() - 25 * 60 * 60 * 1000,
    })
    closeStorage(ctx)

    // Re-init — pruneExpired runs here. The record should be gone.
    const ctx2 = await initStorage()
    expect(await loadSnapshot(ctx2)).toBeNull()
    closeStorage(ctx2)
  })

  it('keeps records younger than 24h', async () => {
    const ctx = await initStorage()
    await saveSnapshot(ctx, { note: 'recent' })
    const record = await readRaw(ctx)
    await writeRaw(ctx, {
      ...record,
      lastSeen: Date.now() - 23 * 60 * 60 * 1000,
    })
    closeStorage(ctx)

    const ctx2 = await initStorage()
    expect(await loadSnapshot(ctx2)).toEqual({ note: 'recent' })
    closeStorage(ctx2)
  })

  it('tolerates records missing lastSeen without throwing', async () => {
    const ctx = await initStorage()
    await saveSnapshot(ctx, { ok: true })
    const record = await readRaw(ctx)
    // Simulate a legacy record by dropping the lastSeen field entirely.
    const { lastSeen: _ignored, ...rest } = record as Record<string, unknown>
    await writeRaw(ctx, rest as unknown as typeof record)
    closeStorage(ctx)

    // Re-init must not throw even though the cursor sees a malformed record.
    const ctx2 = await initStorage()
    closeStorage(ctx2)
  })
})

describe('clearTabIdentity', () => {
  it('removes tab-id and tab-name from sessionStorage', async () => {
    const ctx = await initStorage()
    sessionStorage.setItem('sheet-bro:tab-name', 'MyTab')
    expect(sessionStorage.getItem('sheet-bro:tab-id')).not.toBeNull()
    clearTabIdentity()
    expect(sessionStorage.getItem('sheet-bro:tab-id')).toBeNull()
    expect(sessionStorage.getItem('sheet-bro:tab-name')).toBeNull()
    closeStorage(ctx)
  })

  it('is a no-op when sessionStorage is already empty', () => {
    expect(() => clearTabIdentity()).not.toThrow()
    expect(sessionStorage.getItem('sheet-bro:tab-id')).toBeNull()
  })
})

describe('deleteRecord', () => {
  it('removes only this tab\'s record, leaving others intact', async () => {
    const ctxA = await initStorage()
    await saveSnapshot(ctxA, { tab: 'a' })

    // Write a second record under a different key to simulate another tab.
    const otherId = crypto.randomUUID()
    const snap = { tab: 'b' }
    const encoded = new TextEncoder().encode(JSON.stringify(snap))
    const otherRecord = { iv: new Uint8Array(12), ciphertext: encoded.buffer, lastSeen: Date.now() }
    await new Promise<void>((resolve, reject) => {
      const tx = ctxA.db.transaction('workbooks', 'readwrite')
      tx.objectStore('workbooks').put(otherRecord, otherId)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })

    await deleteRecord(ctxA)
    expect(await loadSnapshot(ctxA)).toBeNull()

    // The other tab's raw record must still be present.
    const still = await new Promise<unknown>((resolve, reject) => {
      const tx = ctxA.db.transaction('workbooks', 'readonly')
      const req = tx.objectStore('workbooks').get(otherId)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    expect(still).not.toBeNull()

    closeStorage(ctxA)
  })
})

describe('clearAllRecords', () => {
  it('wipes every record from the store', async () => {
    const ctxA = await initStorage()
    await saveSnapshot(ctxA, { tab: 'a' })

    // Simulate a second tab's record stored under a different key.
    const otherId = crypto.randomUUID()
    const dummy = { iv: new Uint8Array(12), ciphertext: new ArrayBuffer(0), lastSeen: Date.now() }
    await new Promise<void>((resolve, reject) => {
      const tx = ctxA.db.transaction('workbooks', 'readwrite')
      tx.objectStore('workbooks').put(dummy, otherId)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })

    await clearAllRecords(ctxA)

    // Both records must be gone.
    expect(await loadSnapshot(ctxA)).toBeNull()
    const other = await new Promise<unknown>((resolve, reject) => {
      const tx = ctxA.db.transaction('workbooks', 'readonly')
      const req = tx.objectStore('workbooks').get(otherId)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    expect(other).toBeUndefined()

    closeStorage(ctxA)
  })

  it('resolves without error when the store is already empty', async () => {
    const ctx = await initStorage()
    await expect(clearAllRecords(ctx)).resolves.toBeUndefined()
    closeStorage(ctx)
  })
})

// --- helpers ----------------------------------------------------------------

type RawRecord = {
  iv: Uint8Array | ArrayBuffer
  ciphertext: ArrayBuffer
  lastSeen: number
}

function readRaw(ctx: StorageContext): Promise<RawRecord> {
  return readRawAt(ctx, ctx.tabId) as Promise<RawRecord>
}

function readRawAt(ctx: StorageContext, key: string): Promise<RawRecord | null> {
  return new Promise((resolve, reject) => {
    const tx = ctx.db.transaction('workbooks', 'readonly')
    const req = tx.objectStore('workbooks').get(key)
    req.onsuccess = () => resolve((req.result as RawRecord | undefined) ?? null)
    req.onerror = () => reject(req.error)
  })
}

function writeRaw(ctx: StorageContext, value: RawRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = ctx.db.transaction('workbooks', 'readwrite')
    tx.objectStore('workbooks').put(value, ctx.tabId)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// --- duplicate-tab detection (Web Locks API) ---------------------------------

// Build a mock LockManager whose request() grants or denies the lock on each
// successive call according to the `grants` array (true = grant, false = deny).
// Any call beyond the array length grants by default.
function makeMockLocks(grants: boolean[]): LockManager {
  let i = 0
  return {
    request: vi.fn(
      (_name: string, _opts: LockOptions, cb: LockGrantedCallback<void>): Promise<void> => {
        const grant = i < grants.length ? grants[i++] : true
        cb(grant ? ({ name: _name, mode: 'exclusive' } as Lock) : null)
        return Promise.resolve()
      },
    ),
    query: vi.fn(),
  } as unknown as LockManager
}

// Sets navigator.locks to a mock and returns the mock instance for assertions.
function useMockLocks(grants: boolean[]): LockManager {
  const mock = makeMockLocks(grants)
  Object.defineProperty(navigator, 'locks', { configurable: true, get: () => mock })
  return mock
}

describe('duplicate-tab detection (Web Locks API)', () => {
  let mockLocks: LockManager

  afterEach(() => {
    // Restore navigator.locks to null so other tests remain unaffected.
    Object.defineProperty(navigator, 'locks', { configurable: true, get: () => null })
  })

  function useLocalMockLocks(grants: boolean[]) {
    mockLocks = useMockLocks(grants)
  }

  it('claims lock for a fresh tab (no existing id)', async () => {
    useLocalMockLocks([true])
    const ctx = await initStorage()
    expect(ctx.tabId).toBeTruthy()
    expect((mockLocks.request as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce()
    expect((mockLocks.request as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      `sheet-bro:tab-lock:${ctx.tabId}`,
    )
    closeStorage(ctx)
  })

  it('claims lock for an existing id (original-tab load)', async () => {
    const existingId = crypto.randomUUID()
    sessionStorage.setItem('sheet-bro:tab-id', existingId)
    useLocalMockLocks([true])
    const ctx = await initStorage()
    expect(ctx.tabId).toBe(existingId)
    expect((mockLocks.request as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce()
    closeStorage(ctx)
  })

  it('skips lock check on re-init when lock was already claimed this session', async () => {
    useLocalMockLocks([true])
    const a = await initStorage()
    const b = await initStorage()
    expect(b.tabId).toBe(a.tabId)
    // Lock requested once for the initial claim, not again on re-init.
    expect((mockLocks.request as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
    closeStorage(a)
    closeStorage(b)
  })

  it('detects a duplicated tab: resets identity when lock is unavailable', async () => {
    const stolenId = crypto.randomUUID()
    sessionStorage.setItem('sheet-bro:tab-id', stolenId)
    // First request (for stolen id) denied; second request (for fresh id) granted.
    useLocalMockLocks([false, true])

    const ctx = await initStorage()

    expect(ctx.tabId).not.toBe(stolenId)
    expect(sessionStorage.getItem('sheet-bro:tab-id')).toBe(ctx.tabId)
    const requestMock = mockLocks.request as ReturnType<typeof vi.fn>
    expect(requestMock).toHaveBeenCalledTimes(2)
    expect(requestMock.mock.calls[0][0]).toBe(`sheet-bro:tab-lock:${stolenId}`)
    expect(requestMock.mock.calls[1][0]).toBe(`sheet-bro:tab-lock:${ctx.tabId}`)
    closeStorage(ctx)
  })
})

describe('getOrCreateKey', () => {
  it('throws when WebCrypto is unavailable', async () => {
    const spy = vi.spyOn(crypto, 'subtle', 'get').mockReturnValue(null as unknown as SubtleCrypto)
    try {
      await expect(initStorage()).rejects.toThrow('WebCrypto unavailable')
    } finally {
      spy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// Tab metadata store (tab_metadata) — initTabName / setTabName / getAllTabMeta
// ---------------------------------------------------------------------------

describe('initTabName', () => {
  afterEach(() => {
    Object.defineProperty(navigator, 'locks', { configurable: true, get: () => null })
  })

  it('assigns Sheet-0001 to the first tab in a fresh DB (with locks)', async () => {
    useMockLocks([])
    const ctx = await initStorage()
    const name = await initTabName(ctx.db, ctx.tabId)
    expect(name).toBe('Sheet-0001')
    closeStorage(ctx)
  })

  it('assigns Sheet-0002 to a second tab when Sheet-0001 already exists', async () => {
    useMockLocks([])
    const ctx1 = await initStorage()
    await initTabName(ctx1.db, ctx1.tabId)
    closeStorage(ctx1)

    // Fresh sessionStorage simulates a new tab opening the same DB.
    sessionStorage.clear()
    const ctx2 = await initStorage()
    const name = await initTabName(ctx2.db, ctx2.tabId)
    expect(name).toBe('Sheet-0002')
    closeStorage(ctx2)
  })

  it('uses max + 1, not count + 1 (counter does not recycle gaps)', async () => {
    useMockLocks([])
    // Seed the metadata store with Sheet-0003 directly to simulate a gap.
    const ctx = await initStorage()
    const gapId = crypto.randomUUID()
    await setTabName(ctx.db, gapId, 'Sheet-0003')

    sessionStorage.clear()
    const ctx2 = await initStorage()
    const name = await initTabName(ctx2.db, ctx2.tabId)
    expect(name).toBe('Sheet-0004')
    closeStorage(ctx)
    closeStorage(ctx2)
  })

  it('returns the cached sessionStorage value on re-call without hitting IDB', async () => {
    useMockLocks([])
    const ctx = await initStorage()
    const first = await initTabName(ctx.db, ctx.tabId)
    // Directly overwrite the IDB entry WITHOUT touching sessionStorage, to
    // verify that initTabName reads from the sessionStorage cache on re-call.
    await new Promise<void>((resolve, reject) => {
      const tx = ctx.db.transaction('tab_metadata', 'readwrite')
      tx.objectStore('tab_metadata').put({ name: 'IDB-Changed', lastSeen: Date.now() }, ctx.tabId)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    const second = await initTabName(ctx.db, ctx.tabId)
    expect(second).toBe(first)
    closeStorage(ctx)
  })

  it('falls back to a timestamp-based name when navigator.locks is null', async () => {
    // navigator.locks is null by default in happy-dom (no mock needed).
    const ctx = await initStorage()
    const name = await initTabName(ctx.db, ctx.tabId)
    expect(name).toMatch(/^Sheet-[A-Z0-9]+$/)
    expect(name).not.toBe('Sheet-0001')
    closeStorage(ctx)
  })
})

describe('setTabName / getTabName', () => {
  it('round-trips a name through IDB and updates sessionStorage', async () => {
    const ctx = await initStorage()
    await setTabName(ctx.db, ctx.tabId, 'My-Report-18-Jan-14-30')
    expect(await getTabName(ctx.db, ctx.tabId)).toBe('My-Report-18-Jan-14-30')
    expect(sessionStorage.getItem('sheet-bro:tab-name')).toBe('My-Report-18-Jan-14-30')
    closeStorage(ctx)
  })

  it('overwrites an existing name', async () => {
    const ctx = await initStorage()
    await setTabName(ctx.db, ctx.tabId, 'First')
    await setTabName(ctx.db, ctx.tabId, 'Second')
    expect(await getTabName(ctx.db, ctx.tabId)).toBe('Second')
    closeStorage(ctx)
  })

  it('getTabName returns null for an unknown tabId', async () => {
    const ctx = await initStorage()
    expect(await getTabName(ctx.db, crypto.randomUUID())).toBeNull()
    closeStorage(ctx)
  })
})

describe('getAllTabMeta', () => {
  afterEach(() => {
    Object.defineProperty(navigator, 'locks', { configurable: true, get: () => null })
  })

  it('returns an empty array for a fresh DB', async () => {
    const ctx = await initStorage()
    expect(await getAllTabMeta(ctx.db)).toEqual([])
    closeStorage(ctx)
  })

  it('returns one entry after initTabName is called', async () => {
    useMockLocks([])
    const ctx = await initStorage()
    await initTabName(ctx.db, ctx.tabId)
    const all = await getAllTabMeta(ctx.db)
    expect(all).toHaveLength(1)
    expect(all[0]).toEqual({ tabId: ctx.tabId, name: 'Sheet-0001' })
    closeStorage(ctx)
  })

  it('returns multiple entries after multiple setTabName calls', async () => {
    const ctx = await initStorage()
    const id2 = crypto.randomUUID()
    await setTabName(ctx.db, ctx.tabId, 'Tab-A')
    await setTabName(ctx.db, id2, 'Tab-B')
    const all = await getAllTabMeta(ctx.db)
    expect(all).toHaveLength(2)
    const names = all.map((e) => e.name).sort()
    expect(names).toEqual(['Tab-A', 'Tab-B'])
    closeStorage(ctx)
  })
})

describe('pruneExpired — tab_keys store', () => {
  it('removes stale key rows on init', async () => {
    const ctx = await initStorage()
    const staleId = 'stale-key-tab'
    // Seed a stale key-shaped record directly.
    await new Promise<void>((resolve, reject) => {
      const tx = ctx.db.transaction('tab_keys', 'readwrite')
      tx.objectStore('tab_keys').put(
        { key: ctx.key, lastSeen: Date.now() - 25 * 60 * 60 * 1000 },
        staleId,
      )
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    closeStorage(ctx)

    const ctx2 = await initStorage()
    const raw = await new Promise<unknown>((resolve, reject) => {
      const tx = ctx2.db.transaction('tab_keys', 'readonly')
      const req = tx.objectStore('tab_keys').get(staleId)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    expect(raw).toBeUndefined()
    closeStorage(ctx2)
  })
})

describe('pruneExpired — tab_metadata store', () => {
  it('removes tab_metadata entries older than 24h on init', async () => {
    const ctx = await initStorage()
    const staleId = crypto.randomUUID()
    await setTabName(ctx.db, staleId, 'OldTab')
    // Backdate the metadata record.
    await new Promise<void>((resolve, reject) => {
      const tx = ctx.db.transaction('tab_metadata', 'readwrite')
      tx.objectStore('tab_metadata').put({ name: 'OldTab', lastSeen: Date.now() - 25 * 60 * 60 * 1000 }, staleId)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    closeStorage(ctx)

    const ctx2 = await initStorage()
    expect(await getTabName(ctx2.db, staleId)).toBeNull()
    closeStorage(ctx2)
  })

  it('keeps tab_metadata entries younger than 24h', async () => {
    const ctx = await initStorage()
    await setTabName(ctx.db, ctx.tabId, 'RecentTab')
    closeStorage(ctx)

    const ctx2 = await initStorage()
    expect(await getTabName(ctx2.db, ctx.tabId)).toBe('RecentTab')
    closeStorage(ctx2)
  })

  it('tolerates tab_metadata records missing lastSeen without throwing', async () => {
    const ctx = await initStorage()
    const badId = crypto.randomUUID()
    await new Promise<void>((resolve, reject) => {
      const tx = ctx.db.transaction('tab_metadata', 'readwrite')
      tx.objectStore('tab_metadata').put({ name: 'NoDate' }, badId)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    closeStorage(ctx)

    await expect(initStorage()).resolves.toBeDefined()
  })
})

describe('clearAllRecords — both stores', () => {
  it('clears both workbooks and tab_metadata', async () => {
    const ctx = await initStorage()
    await saveSnapshot(ctx, { data: true })
    await setTabName(ctx.db, ctx.tabId, 'My-Tab')

    await clearAllRecords(ctx)

    expect(await loadSnapshot(ctx)).toBeNull()
    expect(await getTabName(ctx.db, ctx.tabId)).toBeNull()
    closeStorage(ctx)
  })
})

describe('deleteRecord / deleteRecordById — both stores', () => {
  it('deleteRecord removes from both workbooks and tab_metadata', async () => {
    const ctx = await initStorage()
    await saveSnapshot(ctx, { x: 1 })
    await setTabName(ctx.db, ctx.tabId, 'My-Tab')

    await deleteRecord(ctx)

    expect(await loadSnapshot(ctx)).toBeNull()
    expect(await getTabName(ctx.db, ctx.tabId)).toBeNull()
    closeStorage(ctx)
  })

  it('deleteRecordById removes an arbitrary tabId without a StorageContext', async () => {
    const ctx = await initStorage()
    const otherId = crypto.randomUUID()
    // Write data under otherId directly.
    await new Promise<void>((resolve, reject) => {
      const tx = ctx.db.transaction('tab_metadata', 'readwrite')
      tx.objectStore('tab_metadata').put({ name: 'OtherTab', lastSeen: Date.now() }, otherId)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = ctx.db.transaction('workbooks', 'readwrite')
      tx.objectStore('workbooks').put({ iv: new Uint8Array(12), ciphertext: new ArrayBuffer(0), lastSeen: Date.now() }, otherId)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })

    await deleteRecordById(ctx.db, otherId)

    expect(await getTabName(ctx.db, otherId)).toBeNull()
    const wbRecord = await new Promise<unknown>((resolve, reject) => {
      const tx = ctx.db.transaction('workbooks', 'readonly')
      const req = tx.objectStore('workbooks').get(otherId)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    expect(wbRecord).toBeUndefined()

    closeStorage(ctx)
  })

  it('deleteRecord does not remove other tabs\' metadata', async () => {
    const ctx = await initStorage()
    const otherId = crypto.randomUUID()
    await setTabName(ctx.db, otherId, 'OtherTab')
    await setTabName(ctx.db, ctx.tabId, 'ThisTab')

    await deleteRecord(ctx)

    expect(await getTabName(ctx.db, otherId)).toBe('OtherTab')
    closeStorage(ctx)
  })
})

describe('DB upgrade — tab_metadata store created on v1 → v2', () => {
  it('creates both stores on a fresh database', async () => {
    const ctx = await initStorage()
    // Both stores must exist: workbooks (used by saveSnapshot) and tab_metadata.
    await expect(saveSnapshot(ctx, { ok: true })).resolves.toBeUndefined()
    await expect(setTabName(ctx.db, ctx.tabId, 'Test')).resolves.toBeUndefined()
    closeStorage(ctx)
  })

  it('adds tab_keys when upgrading from a v2 database', async () => {
    const v2db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('sheet-bro', 2)
      req.onupgradeneeded = () => {
        req.result.createObjectStore('workbooks')
        req.result.createObjectStore('tab_metadata')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    v2db.close()

    const ctx = await initStorage()
    await expect(saveSnapshot(ctx, { ok: true })).resolves.toBeUndefined()
    expect(await loadSnapshot(ctx)).toEqual({ ok: true })
    closeStorage(ctx)
  })

  it('adds tab_metadata when upgrading from a v1 database', async () => {
    // Manually create a v1 database with only the workbooks store.
    const v1db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('sheet-bro', 1)
      req.onupgradeneeded = () => { req.result.createObjectStore('workbooks') }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    v1db.close()

    // initStorage at DB_VERSION 2 — onupgradeneeded fires with e.oldVersion === 1,
    // skipping the workbooks branch (already exists) and only adding tab_metadata.
    const ctx = await initStorage()
    await expect(setTabName(ctx.db, ctx.tabId, 'Test')).resolves.toBeUndefined()
    closeStorage(ctx)
  })
})

describe('getAllTabMeta — defensive record filter', () => {
  it('skips records without a valid name field', async () => {
    const ctx = await initStorage()
    // Write a malformed entry (no name) directly to tab_metadata.
    await new Promise<void>((resolve, reject) => {
      const tx = ctx.db.transaction('tab_metadata', 'readwrite')
      tx.objectStore('tab_metadata').put({ lastSeen: Date.now() }, 'malformed-id')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    await setTabName(ctx.db, ctx.tabId, 'Valid')
    const all = await getAllTabMeta(ctx.db)
    expect(all.every((e) => typeof e.name === 'string')).toBe(true)
    expect(all.find((e) => e.tabId === 'malformed-id')).toBeUndefined()
    closeStorage(ctx)
  })
})

describe('allocateDefaultName — non-Sheet-NNNN names are ignored', () => {
  afterEach(() => {
    Object.defineProperty(navigator, 'locks', { configurable: true, get: () => null })
  })

  it('ignores file-based names when computing the next sequential number', async () => {
    useMockLocks([])
    const ctx = await initStorage()
    // Seed metadata with a file-based name (not Sheet-NNNN) under a different tabId.
    await setTabName(ctx.db, crypto.randomUUID(), 'My-Report-18-Jan-14-30')
    sessionStorage.clear()
    // New tab: should get Sheet-0001 since no Sheet-NNNN entries exist.
    const ctx2 = await initStorage()
    const name = await initTabName(ctx2.db, ctx2.tabId)
    expect(name).toBe('Sheet-0001')
    closeStorage(ctx)
    closeStorage(ctx2)
  })
})

describe('infrastructure failure cases', () => {
  it('rejects initStorage when indexedDB.open fires onerror', async () => {
    const broken = {
      open(): IDBOpenDBRequest {
        const req = {
          result: null as unknown as IDBDatabase,
          error: new DOMException('simulated open failure', 'UnknownError'),
          onsuccess: null as ((ev: Event) => unknown) | null,
          onerror: null as ((ev: Event) => unknown) | null,
          onupgradeneeded: null as ((ev: IDBVersionChangeEvent) => unknown) | null,
          onblocked: null as ((ev: Event) => unknown) | null,
        }
        queueMicrotask(() => req.onerror?.(new Event('error')))
        return req as unknown as IDBOpenDBRequest
      },
    }
    globalThis.indexedDB = broken as unknown as IDBFactory
    await expect(initStorage()).rejects.toBeDefined()
  })

  it('rejects initStorage when IDB put throws during key creation', async () => {
    // Private-browsing / quota simulation on the tab_keys store: first put
    // throws. Must surface cleanly to the caller — no uncaught error.
    const putSpy = vi
      .spyOn(IDBObjectStore.prototype, 'put')
      .mockImplementationOnce(function (this: IDBObjectStore) {
        throw new DOMException('quota', 'QuotaExceededError')
      })
    await expect(initStorage()).rejects.toBeDefined()
    putSpy.mockRestore()
  })

  it('surfaces a saveSnapshot rejection on quota-exceeded put (caller is responsible for notify)', async () => {
    // Pins "no automatic fallback" from CLAUDE.md: the promise rejects,
    // caller handles UX. Spying on IDBObjectStore.prototype.put lets us
    // flip one specific call site without breaking the rest of the run.
    const ctx = await initStorage()
    const putSpy = vi
      .spyOn(IDBObjectStore.prototype, 'put')
      .mockImplementationOnce(function (this: IDBObjectStore) {
        // fake-indexeddb requests surface errors via req.error + onerror,
        // but the simplest reproducer is to synchronously throw — idbPut's
        // transaction will abort and the wrapper will reject.
        throw new DOMException('quota', 'QuotaExceededError')
      })
    await expect(saveSnapshot(ctx, { snapshot: true })).rejects.toBeDefined()
    putSpy.mockRestore()
    closeStorage(ctx)
  })

  it('initStorage still resolves when navigator.locks is undefined (no-lock fallback)', async () => {
    // happy-dom already omits navigator.locks, but we assert it explicitly
    // so the fallback path at persistence.ts:297-299 stays covered as a
    // contract rather than as an accident of the test environment.
    const desc = Object.getOwnPropertyDescriptor(navigator, 'locks')
    // @ts-expect-error — mutating navigator for the duration of the test
    delete navigator.locks
    try {
      const ctx = await initStorage()
      expect(ctx.tabId).toBeTruthy()
      // A full save → load round-trip still works without locks.
      await saveSnapshot(ctx, { ok: true })
      expect(await loadSnapshot(ctx)).toEqual({ ok: true })
      closeStorage(ctx)
    } finally {
      if (desc) Object.defineProperty(navigator, 'locks', desc)
    }
  })
})

describe('pruneStaleTabRegistry', () => {
  it('removes entries whose Web Lock is free (owner tab is gone)', async () => {
    const { pruneStaleTabRegistry, LOCK_PREFIX } = await import('./persistence')

    // Fake LockManager: "alive-tab" holds its lock; "dead-tab" does not.
    const alive = 'alive-tab'
    const dead = 'dead-tab'
    const fakeLocks = {
      request(name: string, opts: { ifAvailable?: boolean }, cb: (lock: object | null) => unknown) {
        const free = name !== LOCK_PREFIX + alive
        if (opts?.ifAvailable) return Promise.resolve(cb(free ? {} : null))
        return Promise.resolve(cb({}))
      },
    }
    const desc = Object.getOwnPropertyDescriptor(navigator, 'locks')
    Object.defineProperty(navigator, 'locks', { configurable: true, value: fakeLocks })
    try {
      const removed: string[] = []
      await pruneStaleTabRegistry(
        'self-tab',
        [{ tabId: alive }, { tabId: dead }, { tabId: 'self-tab' }],
        (id) => removed.push(id),
      )
      expect(removed).toEqual([dead])
    } finally {
      if (desc) Object.defineProperty(navigator, 'locks', desc)
      else Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
    }
  })

  it('is a no-op when navigator.locks is unavailable', async () => {
    const { pruneStaleTabRegistry } = await import('./persistence')
    const desc = Object.getOwnPropertyDescriptor(navigator, 'locks')
    // @ts-expect-error — mutating navigator for the duration of the test
    delete navigator.locks
    try {
      const removed: string[] = []
      await pruneStaleTabRegistry('self', [{ tabId: 'other' }], (id) => removed.push(id))
      expect(removed).toEqual([])
    } finally {
      if (desc) Object.defineProperty(navigator, 'locks', desc)
    }
  })
})
