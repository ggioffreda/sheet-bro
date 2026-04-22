// NB: changing DB_NAME, TAB_ID_KEY, or KEY_STORE_NAME orphans every
// existing user's encrypted record. If you ever rename these, ship a
// one-shot migration on mount that copies records under the old names
// to the new ones.
const DB_NAME = 'sheet-bro'
const STORE_NAME = 'workbooks'
const META_STORE_NAME = 'tab_metadata'
const KEY_STORE_NAME = 'tab_keys'
const DB_VERSION = 3
const TAB_ID_KEY = 'sheet-bro:tab-id'
const TAB_NAME_KEY = 'sheet-bro:tab-name'
// Legacy sessionStorage slot for the extractable AES key. Kept only as a
// constant so the one-shot cleanup in initStorage reads like documentation.
const LEGACY_ENC_KEY_KEY = 'sheet-bro:enc-key'
const MAX_AGE_MS = 24 * 60 * 60 * 1000
export const LOCK_PREFIX = 'sheet-bro:tab-lock:'
const NAME_LOCK = 'sheet-bro:name-counter'

// The lock name this JS context successfully claimed. Module-level so it
// survives re-calls to initStorage() within the same page load without
// re-testing the lock (which would falsely appear as a duplicate because
// this context already holds it). Reset to undefined on every page load
// (module re-eval), which is exactly when the lock is released.
let heldLockName: string | undefined

export interface StorageContext {
  tabId: string
  key: CryptoKey
  db: IDBDatabase
}

export interface TabMetaRecord {
  name: string
  lastSeen: number
}

interface StoredRecord {
  iv: Uint8Array<ArrayBuffer>
  ciphertext: ArrayBuffer
  lastSeen: number
}

interface StoredKeyRecord {
  key: CryptoKey
  lastSeen: number
}

export async function initStorage(): Promise<StorageContext> {
  // One-shot cleanup for installs that predate the non-extractable-key
  // design. Previous builds stored the raw AES key base64-encoded in
  // sessionStorage; the new key lives in IndexedDB as a non-extractable
  // CryptoKey. The legacy ciphertext under the old key is unrecoverable
  // — accepted because the 24h TTL already scoped it as ephemeral.
  try { sessionStorage.removeItem(LEGACY_ENC_KEY_KEY) } catch { /* ignore */ }

  const db = await openDb()
  await pruneExpired(db)
  const tabId = await resolveTabId()
  const key = await getOrCreateKey(db, tabId)
  return { tabId, key, db }
}

export async function loadSnapshot(ctx: StorageContext): Promise<unknown | null> {
  const record = await idbGet<StoredRecord>(ctx.db, STORE_NAME, ctx.tabId)
  if (!record) return null
  if (!(record.iv instanceof Uint8Array) || record.iv.byteLength !== 12) {
    throw new Error('invalid IV')
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv },
      ctx.key,
      record.ciphertext,
    )
    return JSON.parse(new TextDecoder().decode(plaintext))
  } catch (err) {
    // WebCrypto throws DOMException[OperationError] on AES-GCM tag mismatch.
    // Duck-type by .name so the classification survives realm boundaries
    // (e.g. Node's webcrypto under a jsdom test env has its own DOMException).
    const reason = (err as { name?: string } | null)?.name === 'OperationError'
      ? 'authentication failed (key mismatch or tampered ciphertext)'
      : 'unexpected error during decryption'
    console.warn(`Persistence: ${reason}.`, err)
    throw new Error(reason)
  }
}

export async function saveSnapshot(ctx: StorageContext, snapshot: unknown): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify(snapshot))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    ctx.key,
    plaintext,
  )
  const record: StoredRecord = { iv, ciphertext, lastSeen: Date.now() }
  await idbPut(ctx.db, STORE_NAME, ctx.tabId, record)
  // Touch tab_metadata.lastSeen so the TTL stays in sync with the workbook record.
  const name = sessionStorage.getItem(TAB_NAME_KEY)
  if (name) {
    void idbPut(ctx.db, META_STORE_NAME, ctx.tabId, { name, lastSeen: Date.now() } satisfies TabMetaRecord)
  }
  // Touch the key record too so pruneExpired keeps the key alongside the data.
  void idbPut(ctx.db, KEY_STORE_NAME, ctx.tabId, { key: ctx.key, lastSeen: Date.now() } satisfies StoredKeyRecord)
}

export function closeStorage(ctx: StorageContext): void {
  ctx.db.close()
}

// Wipe the AES key for this tab from IndexedDB. NOT called from `teardown()`
// — doing so would break the core UX of "edits survive a page reload in the
// same tab" (the key must outlive the page to decrypt existing ciphertext).
// Exposed for an opt-in "sign out of this tab" action or future use.
export async function clearKey(ctx: StorageContext): Promise<void> {
  await idbDelete(ctx.db, KEY_STORE_NAME, ctx.tabId)
}

// Drop cross-tab registry entries whose owner is no longer alive. The
// `beforeunload` teardown path removes the entry on a clean close, but
// that event never fires on crashes, force-quits, or sleep-kills — those
// leave stale entries with the full filename intact. We probe
// liveness by briefly claiming each peer's Web Lock: if the lock is
// free, the owning tab is gone.
//
// Expected peers are passed in as an argument so `readAllTabRegistry` /
// `removeTabRegistry` can live in `tab-names.ts` without persistence.ts
// importing its own caller's helpers. In environments without
// `navigator.locks` (plain HTTP, jsdom) this is a no-op — the 24 h TTL
// prune is the fallback there.
export async function pruneStaleTabRegistry(
  selfTabId: string,
  entries: Array<{ tabId: string }>,
  removeEntry: (tabId: string) => void,
): Promise<void> {
  const locks = getLocks()
  if (!locks) return
  await Promise.all(
    entries
      .filter((e) => e.tabId !== selfTabId)
      .map(async (e) => {
        const free = await tryClaimAndRelease(locks, LOCK_PREFIX + e.tabId)
        if (free) removeEntry(e.tabId)
      }),
  )
}

// Try to claim a lock, release it immediately if granted. Returns true
// if we got the lock (i.e. no one else was holding it). Distinct from
// `tryClaimLock` which holds the lock for the page lifetime.
function tryClaimAndRelease(locks: LockManager, name: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    void locks.request(name, { ifAvailable: true }, (lock) => {
      resolve(lock !== null)
      return undefined
    })
  })
}

export function clearTabIdentity(): void {
  sessionStorage.removeItem(TAB_ID_KEY)
  sessionStorage.removeItem(TAB_NAME_KEY)
}

export function deleteRecord(ctx: StorageContext): Promise<void> {
  return deleteRecordById(ctx.db, ctx.tabId)
}

export function deleteRecordById(db: IDBDatabase, tabId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME, META_STORE_NAME, KEY_STORE_NAME], 'readwrite')
    tx.objectStore(STORE_NAME).delete(tabId)
    tx.objectStore(META_STORE_NAME).delete(tabId)
    tx.objectStore(KEY_STORE_NAME).delete(tabId)
    tx.oncomplete = () => resolve()
    /* v8 ignore start */
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
    /* v8 ignore stop */
  })
}

export function clearAllRecords(ctx: StorageContext): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = ctx.db.transaction([STORE_NAME, META_STORE_NAME, KEY_STORE_NAME], 'readwrite')
    tx.objectStore(STORE_NAME).clear()
    tx.objectStore(META_STORE_NAME).clear()
    tx.objectStore(KEY_STORE_NAME).clear()
    tx.oncomplete = () => resolve()
    /* v8 ignore start */
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
    /* v8 ignore stop */
  })
}

// Allocates a tab name for this tab, caching it in sessionStorage. On first
// call: derives a sequential default name (Sheet-0001, Sheet-0002, …) via an
// exclusive Web Lock to prevent two simultaneously-opening tabs from colliding.
// Falls back to a timestamp-based name when Web Locks are unavailable (plain
// HTTP or jsdom). Subsequent calls within the same page load return the cached
// sessionStorage value without hitting IndexedDB.
export async function initTabName(db: IDBDatabase, tabId: string): Promise<string> {
  const cached = sessionStorage.getItem(TAB_NAME_KEY)
  if (cached) return cached
  const name = await allocateDefaultName(db, tabId)
  sessionStorage.setItem(TAB_NAME_KEY, name)
  return name
}

export async function setTabName(db: IDBDatabase, tabId: string, name: string): Promise<void> {
  await idbPut(db, META_STORE_NAME, tabId, { name, lastSeen: Date.now() } satisfies TabMetaRecord)
  sessionStorage.setItem(TAB_NAME_KEY, name)
}

export async function getTabName(db: IDBDatabase, tabId: string): Promise<string | null> {
  const record = await idbGet<TabMetaRecord>(db, META_STORE_NAME, tabId)
  return record?.name ?? null
}

export function getAllTabMeta(db: IDBDatabase): Promise<Array<{ tabId: string; name: string }>> {
  return new Promise((resolve, reject) => {
    const result: Array<{ tabId: string; name: string }> = []
    const tx = db.transaction(META_STORE_NAME, 'readonly')
    const cursorReq = tx.objectStore(META_STORE_NAME).openCursor()
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (!cursor) return
      const record = cursor.value as TabMetaRecord | undefined
      if (record && typeof record.name === 'string') {
        result.push({ tabId: cursor.key as string, name: record.name })
      }
      cursor.continue()
    }
    tx.oncomplete = () => resolve(result)
    /* v8 ignore start */
    tx.onerror = () => reject(tx.error)
    /* v8 ignore stop */
  })
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = req.result
      if (e.oldVersion < 1) db.createObjectStore(STORE_NAME)
      /* v8 ignore start */
      if (e.oldVersion < 2) db.createObjectStore(META_STORE_NAME)
      if (e.oldVersion < 3) db.createObjectStore(KEY_STORE_NAME)
      /* v8 ignore stop */
    }
    req.onsuccess = () => resolve(req.result)
    /* v8 ignore start */
    req.onerror = () => reject(req.error)
    req.onblocked = () => console.warn('Persistence: DB upgrade waiting for other tabs.')
    /* v8 ignore stop */
  })
}

function idbGet<T>(db: IDBDatabase, storeName: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const req = tx.objectStore(storeName).get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    /* v8 ignore start */
    req.onerror = () => reject(req.error)
    /* v8 ignore stop */
  })
}

function idbPut(db: IDBDatabase, storeName: string, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).put(value, key)
    tx.oncomplete = () => resolve()
    /* v8 ignore start */
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
    /* v8 ignore stop */
  })
}

function idbDelete(db: IDBDatabase, storeName: string, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    tx.objectStore(storeName).delete(key)
    tx.oncomplete = () => resolve()
    /* v8 ignore start */
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
    /* v8 ignore stop */
  })
}

function pruneExpired(db: IDBDatabase): Promise<void> {
  const cutoff = Date.now() - MAX_AGE_MS
  return new Promise((resolve) => {
    const tx = db.transaction([STORE_NAME, META_STORE_NAME, KEY_STORE_NAME], 'readwrite')

    const wbCursorReq = tx.objectStore(STORE_NAME).openCursor()
    wbCursorReq.onsuccess = () => {
      const cursor = wbCursorReq.result
      if (!cursor) return
      const record = cursor.value as StoredRecord | undefined
      if (record && typeof record.lastSeen === 'number' && record.lastSeen < cutoff) {
        cursor.delete()
      }
      cursor.continue()
    }

    const metaCursorReq = tx.objectStore(META_STORE_NAME).openCursor()
    metaCursorReq.onsuccess = () => {
      const cursor = metaCursorReq.result
      if (!cursor) return
      const record = cursor.value as TabMetaRecord | undefined
      if (record && typeof record.lastSeen === 'number' && record.lastSeen < cutoff) {
        cursor.delete()
      }
      cursor.continue()
    }

    const keyCursorReq = tx.objectStore(KEY_STORE_NAME).openCursor()
    keyCursorReq.onsuccess = () => {
      const cursor = keyCursorReq.result
      if (!cursor) return
      const record = cursor.value as StoredKeyRecord | undefined
      if (record && typeof record.lastSeen === 'number' && record.lastSeen < cutoff) {
        cursor.delete()
      }
      cursor.continue()
    }

    tx.oncomplete = () => resolve()
    /* v8 ignore start */
    tx.onerror = () => resolve()
    tx.onabort = () => resolve()
    /* v8 ignore stop */
  })
}

// Resolves the tab's identity, detecting cloned tabs via the Web Locks API.
// Chrome's "Duplicate tab" copies sessionStorage (including the tab UUID), so
// the clone arrives holding a UUID whose lock the original tab already owns.
// ifAvailable: true returns null immediately when the lock is taken → clone
// detected → clear identity and start fresh. Falls back silently when the API
// is absent (e.g. HTTP, jsdom).
async function resolveTabId(): Promise<string> {
  const existing = sessionStorage.getItem(TAB_ID_KEY)

  if (existing) {
    if (heldLockName === LOCK_PREFIX + existing) return existing

    const locks = getLocks()
    if (locks) {
      const claimed = await tryClaimLock(locks, LOCK_PREFIX + existing)
      if (claimed) {
        heldLockName = LOCK_PREFIX + existing
        return existing
      }
      // Duplicate tab — discard the copied identity. The original tab still
      // owns the key for `existing` in IndexedDB; don't touch that row.
      sessionStorage.removeItem(TAB_ID_KEY)
      sessionStorage.removeItem(TAB_NAME_KEY)
    } else {
      return existing
    }
  }

  // Fresh tab or reset duplicate — mint new identity and claim its lock
  const newId = crypto.randomUUID()
  sessionStorage.setItem(TAB_ID_KEY, newId)
  const locks = getLocks()
  if (locks) {
    await tryClaimLock(locks, LOCK_PREFIX + newId)
    heldLockName = LOCK_PREFIX + newId
  }
  return newId
}

// navigator.locks is spec-required but null in jsdom and unavailable on plain HTTP.
function getLocks(): LockManager | null {
  return (('locks' in navigator && (navigator.locks as LockManager | null)) || null)
}

function tryClaimLock(locks: LockManager, name: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    void locks.request(name, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(false)
        return undefined
      }
      resolve(true)
      return new Promise<void>(() => {}) // hold until tab closes
    })
  })
}

async function allocateDefaultName(db: IDBDatabase, tabId: string): Promise<string> {
  const locks = getLocks()
  if (!locks) {
    // Fallback when Web Locks are unavailable (plain HTTP, jsdom): sequential
    // numbering is not guaranteed, so use a timestamp suffix for uniqueness.
    const fallback = `Sheet-${Date.now().toString(36).toUpperCase()}`
    await idbPut(db, META_STORE_NAME, tabId, { name: fallback, lastSeen: Date.now() } satisfies TabMetaRecord)
    return fallback
  }
  return new Promise<string>((resolve, reject) => {
    void locks.request(NAME_LOCK, {}, async (_lock: Lock | null): Promise<void> => {
      try {
        const all = await getAllTabMeta(db)
        let maxN = 0
        for (const { name } of all) {
          const m = /^Sheet-(\d{4})$/.exec(name)
          if (m) maxN = Math.max(maxN, parseInt(m[1], 10))
        }
        const name = `Sheet-${String(maxN + 1).padStart(4, '0')}`
        await idbPut(db, META_STORE_NAME, tabId, { name, lastSeen: Date.now() } satisfies TabMetaRecord)
        resolve(name)
      } catch (err) {
        /* v8 ignore start */
        reject(err as Error)
        /* v8 ignore stop */
      }
    })
  })
}

async function getOrCreateKey(db: IDBDatabase, tabId: string): Promise<CryptoKey> {
  if (!crypto?.subtle) {
    throw new Error(
      'WebCrypto unavailable — data will not persist. Serve the app over HTTPS.',
    )
  }
  const existing = await idbGet<StoredKeyRecord>(db, KEY_STORE_NAME, tabId)
  if (existing && existing.key) {
    // Touch lastSeen so the key row's TTL stays aligned with activity.
    void idbPut(db, KEY_STORE_NAME, tabId, { key: existing.key, lastSeen: Date.now() } satisfies StoredKeyRecord)
    return existing.key
  }
  // extractable: false — raw key bytes are never exposed to JS. CryptoKey
  // objects are structured-cloneable, so IndexedDB stores them with the
  // non-extractable internal slot intact.
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  await idbPut(db, KEY_STORE_NAME, tabId, { key, lastSeen: Date.now() } satisfies StoredKeyRecord)
  return key
}
