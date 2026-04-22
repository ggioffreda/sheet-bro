import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import initSqlJs from 'sql.js'

// Mirror sql.test.ts: mock the sqljs loader so safe-export → sqlite → loadSqlJs
// uses a real node-initialised sql.js instead of Vite's ?url resolver.
const { sqlPromise, resolveSql } = vi.hoisted(() => {
  let resolveSql!: (v: unknown) => void
  const sqlPromise = new Promise<unknown>((r) => { resolveSql = r })
  return { sqlPromise, resolveSql }
})
vi.mock('../sqljs', () => ({ loadSqlJs: () => sqlPromise }))

// safeExportXlsx routes through buildXlsxExport → write-excel-file/browser,
// which isn't available in node. Return a small well-formed zip-magic Blob
// so the encryptedZip() step has bytes to wrap.
vi.mock('write-excel-file/browser', () => ({
  default: () => Promise.resolve(new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3])], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })),
}))

import { BlobReader, TextWriter, Uint8ArrayWriter, ZipReader, type FileEntry } from '@zip.js/zip.js'
import { safeExportCsv, safeExportSql, safeExportSqlite, safeExportXlsx } from './safe-export'
import {
  buildFakeUniverAPI,
  captureDownloads,
  type DownloadCapture,
} from '../test-helpers/fake-univer'

const nodeRequire = createRequire(import.meta.url)
const wasmBuffer = readFileSync(nodeRequire.resolve('sql.js/dist/sql-wasm.wasm'))
const SQL = await initSqlJs({
  wasmBinary: wasmBuffer.buffer.slice(
    wasmBuffer.byteOffset,
    wasmBuffer.byteOffset + wasmBuffer.byteLength,
  ),
})
resolveSql(SQL)

async function decryptZipText(blob: Blob, password: string): Promise<{ name: string; text: string }[]> {
  const reader = new ZipReader(new BlobReader(blob), { password })
  const entries = await reader.getEntries()
  const files = entries.filter((e): e is FileEntry => !e.directory)
  const results = await Promise.all(
    files.map(async (e) => ({
      name: e.filename,
      text: await e.getData(new TextWriter()),
    })),
  )
  await reader.close()
  return results
}

async function decryptZipBytes(blob: Blob, password: string): Promise<Uint8Array> {
  const reader = new ZipReader(new BlobReader(blob), { password })
  const entries = await reader.getEntries()
  const file = entries.find((e): e is FileEntry => !e.directory)!
  const bytes = await file.getData(new Uint8ArrayWriter())
  await reader.close()
  return bytes
}

describe('safeExportCsv', () => {
  let capture: DownloadCapture
  beforeEach(() => { capture = captureDownloads() })
  afterEach(() => capture.uninstall())

  it('downloads a ZIP containing the CSV encrypted with the given password', async () => {
    const api = buildFakeUniverAPI([
      { name: 'Sales', rows: [['item', 'qty'], ['Widget', 10], ['Gadget', 3]] },
    ])
    await safeExportCsv(api, 'hunter2')
    expect(capture.calls).toHaveLength(1)
    expect(capture.calls[0].fileName).toBe('Sales.csv.zip')
    const entries = await decryptZipText(capture.calls[0].blob, 'hunter2')
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe('Sales.csv')
    expect(entries[0].text).toContain('item,qty')
    expect(entries[0].text).toContain('Widget')
  })

  it('wrong password causes ZipReader to reject', async () => {
    const api = buildFakeUniverAPI([
      { name: 'Sheet', rows: [['x'], [1]] },
    ])
    await safeExportCsv(api, 'correct')
    const blob = capture.calls[0].blob
    await expect(decryptZipText(blob, 'wrong')).rejects.toThrow()
  })

  it('produces a file starting with PK magic bytes (50 4B 03 04)', async () => {
    const api = buildFakeUniverAPI([
      { name: 'Sheet', rows: [['a'], ['1']] },
    ])
    await safeExportCsv(api, 'pass')
    const zipBlob = capture.calls[0].blob
    const bytes = new Uint8Array(await zipBlob.arrayBuffer())
    expect(bytes[0]).toBe(0x50) // P
    expect(bytes[1]).toBe(0x4b) // K
  })

  it('is a no-op when there is no active workbook', async () => {
    const api = buildFakeUniverAPI(null)
    await safeExportCsv(api, 'pass')
    expect(capture.calls).toHaveLength(0)
  })
})

describe('safeExportXlsx', () => {
  let capture: DownloadCapture
  beforeEach(() => { capture = captureDownloads() })
  afterEach(() => capture.uninstall())

  it('downloads a ZIP containing the xlsx bytes encrypted with the given password', async () => {
    const api = buildFakeUniverAPI([
      { name: 'Only', rows: [['x'], [1]] },
    ])
    await safeExportXlsx(api, 'secret')
    expect(capture.calls).toHaveLength(1)
    expect(capture.calls[0].fileName).toBe('workbook.xlsx.zip')
    const bytes = await decryptZipBytes(capture.calls[0].blob, 'secret')
    // our mocked xlsx "bytes" start with ZIP magic + 4 sentinel bytes
    expect(bytes[0]).toBe(0x50)
    expect(bytes[1]).toBe(0x4b)
  })

  it('is a no-op when there is no active workbook', async () => {
    const api = buildFakeUniverAPI(null)
    await safeExportXlsx(api, 'pass')
    expect(capture.calls).toHaveLength(0)
  })
})

describe('safeExportSql', () => {
  let capture: DownloadCapture
  beforeEach(() => { capture = captureDownloads() })
  afterEach(() => capture.uninstall())

  it('downloads a ZIP containing the SQL and returns table metadata', async () => {
    const api = buildFakeUniverAPI([
      { name: 'users', rows: [['id', 'name'], [1, 'Alice'], [2, 'Bob']] },
    ])
    const result = await safeExportSql(api, 'secret')
    expect(result.tableCount).toBe(1)
    expect(capture.calls[0].fileName).toBe('workbook.sql.zip')
    const entries = await decryptZipText(capture.calls[0].blob, 'secret')
    expect(entries[0].name).toBe('workbook.sql')
    expect(entries[0].text).toContain('CREATE TABLE "users"')
    expect(entries[0].text).toContain("'Alice'")
  })

  it('returns zero counts when workbook is empty', async () => {
    const api = buildFakeUniverAPI([])
    const result = await safeExportSql(api, 'pass')
    expect(result).toEqual({ tableCount: 0, generatedHeaderCount: 0 })
    expect(capture.calls).toHaveLength(0)
  })
})

describe('safeExportSqlite', () => {
  let capture: DownloadCapture
  beforeEach(() => { capture = captureDownloads() })
  afterEach(() => capture.uninstall())

  it('downloads a ZIP containing a valid SQLite binary and returns table metadata', { timeout: 10_000 }, async () => {
    const api = buildFakeUniverAPI([
      { name: 'items', rows: [['sku', 'price'], ['A1', 9.99], ['B2', 4.50]] },
    ])
    const result = await safeExportSqlite(api, 'mypassword')
    expect(result.tableCount).toBe(1)
    expect(capture.calls[0].fileName).toBe('workbook.sqlite.zip')
    const bytes = await decryptZipBytes(capture.calls[0].blob, 'mypassword')
    const magic = new TextDecoder().decode(bytes.slice(0, 15))
    expect(magic).toBe('SQLite format 3')
  })

  it('returns zero counts when workbook is empty', async () => {
    const api = buildFakeUniverAPI([])
    const result = await safeExportSqlite(api, 'pass')
    expect(result).toEqual({ tableCount: 0, generatedHeaderCount: 0 })
    expect(capture.calls).toHaveLength(0)
  })
})

describe('encrypted ZIP integrity', () => {
  let capture: DownloadCapture
  beforeEach(() => { capture = captureDownloads() })
  afterEach(() => capture.uninstall())

  it('rejects a tampered ZIP with a clean error rather than returning garbage', async () => {
    const api = buildFakeUniverAPI([
      { name: 'Sheet', rows: [['x'], [1]] },
    ])
    await safeExportCsv(api, 'pass')
    const bytes = new Uint8Array(await capture.calls[0].blob.arrayBuffer())
    // Flip a byte well inside the encrypted payload (past the 30-byte local
    // file header) to force the AES/HMAC check to fail rather than the
    // central-directory walk.
    const target = Math.min(bytes.length - 1, 100)
    bytes[target] ^= 0xff
    const tamperedBlob = new Blob([bytes as unknown as BlobPart], { type: 'application/zip' })
    await expect(decryptZipText(tamperedBlob, 'pass')).rejects.toThrow()
  })

  it('handles a mid-size sheet (~5 MB of rows) without throwing', { timeout: 20_000 }, async () => {
    // Not a perf test — just a sanity check that the ZIP streaming path
    // doesn't blow up on a sheet larger than a trivial fixture. ~50k rows
    // of ~100-byte payload → ~5 MB uncompressed CSV.
    const rows: (string | number)[][] = [['id', 'payload']]
    const payload = 'x'.repeat(80)
    for (let i = 0; i < 50_000; i++) rows.push([i, payload])
    const api = buildFakeUniverAPI([{ name: 'Big', rows }])
    await safeExportCsv(api, 'pw')
    expect(capture.calls).toHaveLength(1)
    const bytes = new Uint8Array(await capture.calls[0].blob.arrayBuffer())
    expect(bytes[0]).toBe(0x50)
    expect(bytes[1]).toBe(0x4b)
    expect(bytes.length).toBeGreaterThan(10_000) // sanity: not an empty zip
  })
})
