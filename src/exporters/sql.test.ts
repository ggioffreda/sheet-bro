import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import initSqlJs, { type Database } from 'sql.js'

// Mock the project's sqljs loader before any static import of modules that
// reach it (exporters/sqlite.ts → ../sqljs). The real loader uses Vite's
// `?url` resolver which does not work under vitest-node. We hand the real,
// node-initialised SQL instance to the mocked loader below.
const { sqlPromise, resolveSql } = vi.hoisted(() => {
  let resolveSql!: (v: unknown) => void
  const sqlPromise = new Promise<unknown>((r) => { resolveSql = r })
  return { sqlPromise, resolveSql }
})
vi.mock('../sqljs', () => ({ loadSqlJs: () => sqlPromise }))

import { normalizeToSqlite } from '../importers/sql-dialect'
import { buildSqlText, exportSql } from './sql'
import { buildDbBytes, exportSqlite } from './sqlite'
import { buildTableSpec, type SheetData, type TableSpec } from './shared'
import {
  buildFakeUniverAPI,
  captureDownloads,
  readBlobBytes,
  readBlobText,
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

function spec(name: string, rows: (string | number | null)[][]): TableSpec {
  const sheet: SheetData = { name, rows }
  return buildTableSpec(sheet, new Set())!
}

function openText(text: string): Database {
  const db = new SQL.Database()
  db.exec(text)
  return db
}

function openBytes(bytes: Uint8Array): Database {
  return new SQL.Database(bytes)
}

function rowsOf(db: Database, table: string): unknown[][] {
  const res = db.exec(`SELECT * FROM "${table}"`)
  return res.length === 0 ? [] : res[0].values
}

describe('buildSqlText', () => {
  it('round-trips through sql.js with typed columns', () => {
    const s = spec('Sales', [
      ['id', 'name', 'price'],
      ['1', 'Widget', '9.99'],
      ['2', 'Gizmo', '12'],
      ['3', "O'Reilly", null],
    ])
    const sql = buildSqlText([s])
    const db = openText(sql)
    expect(rowsOf(db, 'Sales')).toEqual([
      [1, 'Widget', 9.99],
      [2, 'Gizmo', 12],
      [3, "O'Reilly", null],
    ])
    // Verify column types landed correctly
    const schema = db.exec("SELECT type FROM pragma_table_info('Sales') ORDER BY cid")
    expect(schema[0].values.map((r) => r[0])).toEqual(['INTEGER', 'TEXT', 'REAL'])
    db.close()
  })

  it('emits generated column names when row 0 is data', () => {
    const s = spec('nums', [
      ['1', '2', '3'],
      ['4', '5', '6'],
    ])
    const sql = buildSqlText([s])
    const db = openText(sql)
    const schema = db.exec("SELECT name FROM pragma_table_info('nums') ORDER BY cid")
    expect(schema[0].values.map((r) => r[0])).toEqual(['col1', 'col2', 'col3'])
    expect(rowsOf(db, 'nums')).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ])
    db.close()
  })

  it('preserves long-integer strings as TEXT', () => {
    const s = spec('ids', [
      ['bigint'],
      ['9007199254740993'], // 16 digits, beyond JS safe integer
      ['12345678901234567890'],
    ])
    const sql = buildSqlText([s])
    const db = openText(sql)
    const schema = db.exec("SELECT type FROM pragma_table_info('ids') ORDER BY cid")
    expect(schema[0].values[0][0]).toBe('TEXT')
    expect(rowsOf(db, 'ids')).toEqual([['9007199254740993'], ['12345678901234567890']])
    db.close()
  })

  it('preserves leading zeros as TEXT', () => {
    const s = spec('zips', [
      ['zip'],
      ['00210'],
      ['90210'],
    ])
    const sql = buildSqlText([s])
    const db = openText(sql)
    const schema = db.exec("SELECT type FROM pragma_table_info('zips') ORDER BY cid")
    expect(schema[0].values[0][0]).toBe('TEXT')
    expect(rowsOf(db, 'zips')).toEqual([['00210'], ['90210']])
    db.close()
  })

  it('escapes single quotes and handles newlines in strings', () => {
    const s = spec('notes', [
      ['body'],
      ["it's"],
      ['line1\nline2'],
      ['tab\there'],
    ])
    const sql = buildSqlText([s])
    const db = openText(sql)
    expect(rowsOf(db, 'notes')).toEqual([["it's"], ['line1\nline2'], ['tab\there']])
    db.close()
  })

  it('emits idempotent SQL under the MySQL→SQLite normalizer', () => {
    const s = spec('t', [['col'], ['1'], ['2']])
    const out = buildSqlText([s])
    const normalized = normalizeToSqlite(out)
    const dbOrig = openText(out)
    const dbNorm = openText(normalized)
    expect(rowsOf(dbOrig, 't')).toEqual(rowsOf(dbNorm, 't'))
    dbOrig.close()
    dbNorm.close()
  })

  it('handles multiple tables with distinct schemas', () => {
    const a = spec('users', [
      ['id', 'email'],
      ['1', 'a@ex.com'],
    ])
    const b = spec('orders', [
      ['id', 'total'],
      ['1', '9.99'],
      ['2', '5.50'],
    ])
    const sql = buildSqlText([a, b])
    const db = openText(sql)
    expect(rowsOf(db, 'users')).toEqual([[1, 'a@ex.com']])
    expect(rowsOf(db, 'orders')).toEqual([[1, 9.99], [2, 5.5]])
    db.close()
  })

  it('strips NUL bytes from string values', () => {
    const s = spec('t', [
      ['body'],
      ['before\x00after'],
      ['\x00leading'],
      ['trailing\x00'],
      ['\x00\x00all'],
    ])
    const sql = buildSqlText([s])
    // The emitted text must not contain a raw NUL byte.
    expect(sql.includes('\x00')).toBe(false)
    const db = openText(sql)
    expect(rowsOf(db, 't')).toEqual([
      ['beforeafter'],
      ['leading'],
      ['trailing'],
      ['all'],
    ])
    db.close()
  })

  it('emits NULL for non-finite numbers', () => {
    // classifyCell maps non-finite → 'text' so the column becomes TEXT and
    // the number coerces to null via coerceForColumn — but if a caller
    // bypasses buildTableSpec, sqlLiteral itself must still produce NULL.
    const s: TableSpec = {
      tableName: 'nums',
      columns: [
        { name: 'a', type: 'REAL' },
        { name: 'b', type: 'REAL' },
      ],
      rows: [[Number.POSITIVE_INFINITY, Number.NaN]],
      usedGeneratedHeader: true,
    }
    const sql = buildSqlText([s])
    const db = openText(sql)
    expect(rowsOf(db, 'nums')).toEqual([[null, null]])
    db.close()
  })

  it('round-trips more than one BATCH of rows (>500)', () => {
    const rows: (string | number | null)[][] = [['id', 'n']]
    for (let i = 1; i <= 1234; i++) rows.push([String(i), String(i * 2)])
    const s = spec('big', rows)
    const sql = buildSqlText([s])
    const db = openText(sql)
    const res = db.exec('SELECT COUNT(*), SUM(n), MIN(id), MAX(id) FROM "big"')
    expect(res[0].values[0]).toEqual([1234, 1234 * 1235, 1, 1234])
    db.close()
  })

  it('emits a well-formed empty workbook for zero specs', () => {
    const sql = buildSqlText([])
    expect(sql).toContain('BEGIN TRANSACTION;')
    expect(sql).toContain('COMMIT;')
    // Should parse cleanly (empty transaction is a no-op for SQLite).
    const db = openText(sql)
    db.close()
  })

  it('handles a spec with zero rows (schema only)', () => {
    const s: TableSpec = {
      tableName: 'empty',
      columns: [
        { name: 'id', type: 'INTEGER' },
        { name: 'name', type: 'TEXT' },
      ],
      rows: [],
      usedGeneratedHeader: false,
    }
    const sql = buildSqlText([s])
    // No INSERT statement when rows are empty.
    expect(sql).not.toMatch(/INSERT INTO\s+"empty"/)
    const db = openText(sql)
    expect(rowsOf(db, 'empty')).toEqual([])
    db.close()
  })

  it('serializes raw booleans as integers 0/1 (pre-coercion path)', () => {
    // buildTableSpec normally coerces booleans to "TRUE"/"FALSE" text, but
    // sqlLiteral itself has a boolean branch that emits 0/1 so the SQL text
    // output stays consistent with sql.js binary bindings if a caller skips
    // the coercion layer.
    const s: TableSpec = {
      tableName: 'flags',
      columns: [
        { name: 'a', type: 'INTEGER' },
        { name: 'b', type: 'INTEGER' },
      ],
      rows: [[true, false]],
      usedGeneratedHeader: true,
    }
    const sql = buildSqlText([s])
    expect(sql).toMatch(/VALUES\s*\n\s*\(1, 0\)/)
    const db = openText(sql)
    expect(rowsOf(db, 'flags')).toEqual([[1, 0]])
    db.close()
  })
})

describe('buildDbBytes', () => {
  it('produces a valid SQLite file that re-opens with identical data', () => {
    const s = spec('t', [
      ['id', 'name', 'qty'],
      ['1', 'apple', '3'],
      ['2', 'pear', '5'],
    ])
    const bytes = buildDbBytes(SQL, [s])
    // SQLite file magic header.
    expect(new TextDecoder().decode(bytes.slice(0, 15))).toBe('SQLite format 3')
    const db = openBytes(bytes)
    expect(rowsOf(db, 't')).toEqual([
      [1, 'apple', 3],
      [2, 'pear', 5],
    ])
    db.close()
  })

  it('stores generated-header columns as col1..colN', () => {
    const s = spec('data', [
      ['1', '2'],
      ['3', '4'],
    ])
    const bytes = buildDbBytes(SQL, [s])
    const db = openBytes(bytes)
    const schema = db.exec("SELECT name FROM pragma_table_info('data') ORDER BY cid")
    expect(schema[0].values.map((r) => r[0])).toEqual(['col1', 'col2'])
    db.close()
  })

  it('strips NUL bytes when binding string values', () => {
    const s = spec('t', [
      ['body'],
      ['before\x00after'],
      ['\x00lead'],
    ])
    const bytes = buildDbBytes(SQL, [s])
    const db = openBytes(bytes)
    expect(rowsOf(db, 't')).toEqual([['beforeafter'], ['lead']])
    db.close()
  })

  it('binds raw booleans as TEXT "TRUE"/"FALSE" (forBind contract)', () => {
    // Match the TEXT exporter's pre-coercion branch for consistency when a
    // caller hands booleans directly to buildDbBytes.
    const s: TableSpec = {
      tableName: 'flags',
      columns: [
        { name: 'a', type: 'TEXT' },
        { name: 'b', type: 'TEXT' },
      ],
      rows: [[true, false]],
      usedGeneratedHeader: true,
    }
    const bytes = buildDbBytes(SQL, [s])
    const db = openBytes(bytes)
    expect(rowsOf(db, 'flags')).toEqual([['TRUE', 'FALSE']])
    db.close()
  })

  it('binds explicit nulls as SQLite NULL (forBind null branch)', () => {
    const s: TableSpec = {
      tableName: 'n',
      columns: [
        { name: 'a', type: 'TEXT' },
        { name: 'b', type: 'TEXT' },
      ],
      rows: [[null, 'x'], ['y', null]],
      usedGeneratedHeader: true,
    }
    const bytes = buildDbBytes(SQL, [s])
    const db = openBytes(bytes)
    expect(rowsOf(db, 'n')).toEqual([[null, 'x'], ['y', null]])
    db.close()
  })

  it('binds non-finite numbers as NULL', () => {
    const s: TableSpec = {
      tableName: 'n',
      columns: [
        { name: 'a', type: 'REAL' },
        { name: 'b', type: 'REAL' },
      ],
      rows: [[Number.POSITIVE_INFINITY, Number.NaN]],
      usedGeneratedHeader: true,
    }
    const bytes = buildDbBytes(SQL, [s])
    const db = openBytes(bytes)
    expect(rowsOf(db, 'n')).toEqual([[null, null]])
    db.close()
  })

  it('handles >500 rows inside a single transaction', () => {
    const rows: (string | number | null)[][] = [['id']]
    for (let i = 1; i <= 1234; i++) rows.push([String(i)])
    const s = spec('big', rows)
    const bytes = buildDbBytes(SQL, [s])
    const db = openBytes(bytes)
    const res = db.exec('SELECT COUNT(*), SUM(id) FROM "big"')
    expect(res[0].values[0]).toEqual([1234, (1234 * 1235) / 2])
    db.close()
  })

  it('creates schema but no rows for an empty spec', () => {
    const s: TableSpec = {
      tableName: 'empty',
      columns: [{ name: 'id', type: 'INTEGER' }],
      rows: [],
      usedGeneratedHeader: false,
    }
    const bytes = buildDbBytes(SQL, [s])
    const db = openBytes(bytes)
    const schema = db.exec("SELECT name, type FROM pragma_table_info('empty')")
    expect(schema[0].values).toEqual([['id', 'INTEGER']])
    expect(rowsOf(db, 'empty')).toEqual([])
    db.close()
  })

  it('returns a parseable empty database for zero specs', () => {
    // sql.js returns zero-length bytes for a database with no pages; that is
    // valid input to new SQL.Database() and exposes an empty sqlite_master.
    const bytes = buildDbBytes(SQL, [])
    const db = openBytes(bytes)
    const res = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    expect(res).toEqual([])
    db.close()
  })
})

describe('exportSql (wrapper)', () => {
  let capture: DownloadCapture
  beforeEach(() => { capture = captureDownloads() })
  afterEach(() => capture.uninstall())

  it('writes a workbook.sql download and reports table/header counts', () => {
    const api = buildFakeUniverAPI([
      { name: 'Users', rows: [['id', 'email'], [1, 'a@x']] },
      { name: 'Logs', rows: [['when'], ['2024-01-01']] },
    ])
    const result = exportSql(api)
    expect(result).toEqual({ tableCount: 2, generatedHeaderCount: 0 })
    expect(capture.calls).toHaveLength(1)
    expect(capture.calls[0].fileName).toBe('workbook.sql')
  })

  it('counts sheets that fell back to generated headers', () => {
    const api = buildFakeUniverAPI([
      // Numeric row 0 → no header detected → generated col1/col2.
      { name: 'nums', rows: [[1, 2], [3, 4]] },
      { name: 'named', rows: [['id'], [1]] },
    ])
    const result = exportSql(api)
    expect(result.tableCount).toBe(2)
    expect(result.generatedHeaderCount).toBe(1)
  })

  it('reports zero counts and skips the download when the workbook is empty', () => {
    const api = buildFakeUniverAPI([])
    const result = exportSql(api)
    expect(result).toEqual({ tableCount: 0, generatedHeaderCount: 0 })
    expect(capture.calls).toHaveLength(0)
  })

  it('reports zero counts and skips the download with no active workbook', () => {
    const api = buildFakeUniverAPI(null)
    const result = exportSql(api)
    expect(result).toEqual({ tableCount: 0, generatedHeaderCount: 0 })
    expect(capture.calls).toHaveLength(0)
  })

  it('downloads text that sql.js can round-trip', async () => {
    const api = buildFakeUniverAPI([
      { name: 'Users', rows: [['id', 'name'], [1, 'Alice'], [2, 'Bob']] },
    ])
    exportSql(api)
    const text = await readBlobText(capture.calls[0].blob)
    const db = openText(text)
    expect(rowsOf(db, 'Users')).toEqual([[1, 'Alice'], [2, 'Bob']])
    db.close()
  })

  it('falls back to "Sheet" as the table name when the sheet has a blank name', () => {
    // Covers the `sheet.getSheetName() || 'Sheet'` branch inside
    // collectTableSpecs — a sheet without a name still produces a valid
    // SQL table (sanitizeSqlIdent resolves "Sheet" → "Sheet").
    const api = buildFakeUniverAPI([
      { name: '', rows: [['id'], [1], [2]] },
    ])
    const result = exportSql(api)
    expect(result.tableCount).toBe(1)
  })

  it('skips sheets that produce a null table spec (fully empty)', () => {
    // Covers the `if (spec) out.push(spec)` branch in collectTableSpecs —
    // buildTableSpec returns null for an empty sheet, and we must drop it
    // from the exported table list rather than emitting an empty CREATE.
    const api = buildFakeUniverAPI([
      { name: 'Empty', rows: [] },
      { name: 'Real', rows: [['id'], [1]] },
    ])
    const result = exportSql(api)
    expect(result.tableCount).toBe(1)
  })
})

describe('exportSqlite (wrapper)', () => {
  let capture: DownloadCapture
  beforeEach(() => { capture = captureDownloads() })
  afterEach(() => capture.uninstall())

  it('writes a workbook.sqlite download with valid SQLite bytes', async () => {
    const api = buildFakeUniverAPI([
      { name: 'Items', rows: [['id', 'name'], [1, 'x'], [2, 'y']] },
    ])
    const result = await exportSqlite(api)
    expect(result).toEqual({ tableCount: 1, generatedHeaderCount: 0 })
    expect(capture.calls[0].fileName).toBe('workbook.sqlite')
    const bytes = await readBlobBytes(capture.calls[0].blob)
    expect(new TextDecoder().decode(bytes.slice(0, 15))).toBe('SQLite format 3')
    const db = openBytes(bytes)
    expect(rowsOf(db, 'Items')).toEqual([[1, 'x'], [2, 'y']])
    db.close()
  })

  it('counts generated-header tables', async () => {
    const api = buildFakeUniverAPI([
      { name: 'raw', rows: [[1, 2], [3, 4]] },
    ])
    const result = await exportSqlite(api)
    expect(result).toEqual({ tableCount: 1, generatedHeaderCount: 1 })
  })

  it('reports zero counts and does not download when the workbook is empty', async () => {
    const api = buildFakeUniverAPI([])
    const result = await exportSqlite(api)
    expect(result).toEqual({ tableCount: 0, generatedHeaderCount: 0 })
    expect(capture.calls).toHaveLength(0)
  })

  it('reports zero counts with no active workbook', async () => {
    const api = buildFakeUniverAPI(null)
    const result = await exportSqlite(api)
    expect(result).toEqual({ tableCount: 0, generatedHeaderCount: 0 })
    expect(capture.calls).toHaveLength(0)
  })
})

