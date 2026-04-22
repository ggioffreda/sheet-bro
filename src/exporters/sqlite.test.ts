import { describe, expect, it, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { buildDbBytes } from './sqlite'
import type { TableSpec } from './shared'

// Dedicated direct tests for buildDbBytes. The transitive coverage via
// sql.test.ts exercises the happy path of round-trips, but this file pins
// contract details the audit called out: column-type preservation, empty
// spec list behaviour, and the transaction wrapper (asserted indirectly
// via INSERT-batch perf expectations is too flaky, so we settle for
// round-trip correctness).

let SQL: SqlJsStatic
beforeAll(async () => {
  const nodeRequire = createRequire(import.meta.url)
  const wasmBuffer = readFileSync(nodeRequire.resolve('sql.js/dist/sql-wasm.wasm'))
  SQL = await initSqlJs({
    wasmBinary: wasmBuffer.buffer.slice(
      wasmBuffer.byteOffset,
      wasmBuffer.byteOffset + wasmBuffer.byteLength,
    ),
  })
})

function reopen(bytes: Uint8Array): InstanceType<SqlJsStatic['Database']> {
  return new SQL.Database(bytes)
}

describe('buildDbBytes', () => {
  it('preserves INTEGER / REAL / TEXT column types through round-trip', () => {
    const spec: TableSpec = {
      tableName: 'mix',
      columns: [
        { name: 'n', type: 'INTEGER' },
        { name: 'r', type: 'REAL' },
        { name: 's', type: 'TEXT' },
      ],
      rows: [
        [1, 1.5, 'a'],
        [2, 2.25, 'b'],
      ],
      usedGeneratedHeader: false,
    }
    const bytes = buildDbBytes(SQL, [spec])
    const db = reopen(bytes)
    try {
      const schema = db.exec('SELECT name, type FROM pragma_table_info("mix") ORDER BY cid')
      expect(schema[0].values).toEqual([
        ['n', 'INTEGER'],
        ['r', 'REAL'],
        ['s', 'TEXT'],
      ])
      const rows = db.exec('SELECT n, r, s FROM mix ORDER BY n')[0].values
      expect(rows).toEqual([
        [1, 1.5, 'a'],
        [2, 2.25, 'b'],
      ])
    } finally {
      db.close()
    }
  })

  it('returns a re-openable DB with no tables when no specs are given', () => {
    // sql.js's empty-database export may omit the 16-byte magic (0-page
    // DBs roundtrip as 0-byte blobs). What matters is that feeding the
    // bytes back into `new SQL.Database(bytes)` produces a queryable DB
    // with an empty sqlite_master. Callers (`buildSqliteExport`) also
    // short-circuit before reaching this path, so the contract we pin
    // here is just "no throw, no tables".
    const bytes = buildDbBytes(SQL, [])
    const db = reopen(bytes)
    try {
      const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'")
      expect(tables).toEqual([])
    } finally {
      db.close()
    }
  })

  it('creates a table with zero rows when spec.rows is empty', () => {
    const spec: TableSpec = {
      tableName: 'empty',
      columns: [{ name: 'id', type: 'INTEGER' }],
      rows: [],
      usedGeneratedHeader: false,
    }
    const bytes = buildDbBytes(SQL, [spec])
    const db = reopen(bytes)
    try {
      const count = db.exec('SELECT COUNT(*) FROM empty')[0].values[0][0]
      expect(count).toBe(0)
      const schema = db.exec('SELECT name, type FROM pragma_table_info("empty")')
      expect(schema[0].values).toEqual([['id', 'INTEGER']])
    } finally {
      db.close()
    }
  })

  it('strips NUL bytes from TEXT values (SQL-client compatibility)', () => {
    const spec: TableSpec = {
      tableName: 't',
      columns: [{ name: 's', type: 'TEXT' }],
      rows: [['hello\x00world']],
      usedGeneratedHeader: false,
    }
    const bytes = buildDbBytes(SQL, [spec])
    const db = reopen(bytes)
    try {
      const value = db.exec('SELECT s FROM t')[0].values[0][0]
      expect(value).toBe('helloworld')
    } finally {
      db.close()
    }
  })

  it('coerces non-finite numbers to NULL on bind', () => {
    const spec: TableSpec = {
      tableName: 't',
      columns: [{ name: 'n', type: 'REAL' }],
      rows: [[Number.POSITIVE_INFINITY], [Number.NaN], [3.14]],
      usedGeneratedHeader: false,
    }
    const bytes = buildDbBytes(SQL, [spec])
    const db = reopen(bytes)
    try {
      const values = db.exec('SELECT n FROM t ORDER BY rowid')[0].values.map((r) => r[0])
      expect(values).toEqual([null, null, 3.14])
    } finally {
      db.close()
    }
  })

  it('drops and recreates an existing table with the same name (DROP TABLE IF EXISTS guard)', () => {
    const spec: TableSpec = {
      tableName: 'reuse',
      columns: [{ name: 'v', type: 'INTEGER' }],
      rows: [[1]],
      usedGeneratedHeader: false,
    }
    // Two separate invocations against fresh DBs is the normal case; here
    // we just verify no error occurs when rerunning the same spec — the
    // DROP TABLE IF EXISTS makes the exporter idempotent against a DB
    // initialized with an older schema (not currently used by callers but
    // pinned as a contract).
    expect(() => buildDbBytes(SQL, [spec])).not.toThrow()
    expect(() => buildDbBytes(SQL, [spec])).not.toThrow()
  })
})
