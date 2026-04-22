import { beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import initSqlJs, { type SqlJsStatic } from 'sql.js'

// Mock the sqljs loader so the importer doesn't try to Vite-resolve the
// `?url` wasm asset inside the node test runner. We resolve sql.js the same
// way the sibling sql.test.ts suite does.
let SQL: SqlJsStatic
vi.mock('../sqljs', () => ({
  loadSqlJs: () => Promise.resolve(SQL),
}))

// Imports must come AFTER vi.mock so the mocked module wins.
import { importSql, isSqliteFile, isSqlDumpFile } from './sql'

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

describe('isSqliteFile', () => {
  it.each([
    ['foo.sqlite', true],
    ['foo.SQLITE', true],
    ['foo.sqlite3', true],
    ['foo.db', true],
    ['FOO.DB', true],
    ['foo.sqlitex', false],
    ['foo.sql', false],
    ['foo.csv', false],
    ['foo', false],
    ['.sqlite.bak', false],
  ] as const)('%s → %s', (name, expected) => {
    expect(isSqliteFile(new File([], name))).toBe(expected)
  })
})

describe('isSqlDumpFile', () => {
  it.each([
    ['foo.sql', true],
    ['foo.SQL', true],
    ['foo.sql.gz', false],
    ['foo.sqlite', false],
    ['foo', false],
  ] as const)('%s → %s', (name, expected) => {
    expect(isSqlDumpFile(new File([], name))).toBe(expected)
  })
})

describe('importSql — binary .sqlite path', () => {
  function makeSqliteFile(bytes: Uint8Array, name = 'in.sqlite'): File {
    return new File([bytes as BlobPart], name, { type: 'application/vnd.sqlite3' })
  }

  function buildDb(setup: (db: InstanceType<SqlJsStatic['Database']>) => void): Uint8Array {
    const db = new SQL.Database()
    try {
      setup(db)
      return db.export()
    } finally {
      db.close()
    }
  }

  it('reads a table and prepends column names as row 0', async () => {
    const bytes = buildDb((db) => {
      db.exec(`CREATE TABLE users (id INTEGER, email TEXT);
               INSERT INTO users VALUES (1, 'a@ex.com'), (2, 'b@ex.com');`)
    })
    const sheets = await importSql(makeSqliteFile(bytes))
    expect(sheets).toEqual([
      {
        name: 'users',
        rows: [
          ['id', 'email'],
          [1, 'a@ex.com'],
          [2, 'b@ex.com'],
        ],
      },
    ])
  })

  it('returns [] for a DB with no user tables', async () => {
    const bytes = buildDb(() => {})
    const sheets = await importSql(makeSqliteFile(bytes))
    expect(sheets).toEqual([])
  })

  it('skips sqlite_* internal tables but includes user tables', async () => {
    // AUTOINCREMENT forces sqlite to materialize `sqlite_sequence`, so we
    // get a real internal table in the DB without tripping SQLite's
    // "reserved for internal use" guard on CREATE TABLE sqlite_*.
    const bytes = buildDb((db) => {
      db.exec(`CREATE TABLE visible (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT);
               INSERT INTO visible (v) VALUES ('x');`)
    })
    // Sanity-check: the internal table is present before import.
    const sanity = new SQL.Database(bytes)
    try {
      const names = sanity
        .exec("SELECT name FROM sqlite_master WHERE type='table'")[0]
        .values.map((r) => String(r[0]))
      expect(names).toContain('sqlite_sequence')
    } finally {
      sanity.close()
    }
    const sheets = await importSql(makeSqliteFile(bytes))
    expect(sheets.map((s) => s.name)).toEqual(['visible'])
  })

  it('exposes multiple tables sorted by name', async () => {
    const bytes = buildDb((db) => {
      db.exec(`CREATE TABLE zeta (id INTEGER); INSERT INTO zeta VALUES (1);
               CREATE TABLE alpha (id INTEGER); INSERT INTO alpha VALUES (2);
               CREATE TABLE mike (id INTEGER); INSERT INTO mike VALUES (3);`)
    })
    const sheets = await importSql(makeSqliteFile(bytes))
    expect(sheets.map((s) => s.name)).toEqual(['alpha', 'mike', 'zeta'])
  })

  it('represents an empty user table as a name + zero rows', async () => {
    const bytes = buildDb((db) => {
      db.exec(`CREATE TABLE empty (id INTEGER, name TEXT);`)
    })
    const sheets = await importSql(makeSqliteFile(bytes))
    // readAllTables runs SELECT * which returns zero result sets for an empty
    // table; the importer surfaces that as { rows: [] }.
    expect(sheets).toEqual([{ name: 'empty', rows: [] }])
  })

  it('safely handles a table name containing an embedded double quote', async () => {
    // SQL injection defense: the importer must double-quote and escape the
    // identifier. This is the one dangerous branch in the whole pipeline.
    const weird = 'evil"; DROP TABLE ok; --'
    const bytes = buildDb((db) => {
      // sql.js itself requires the name to be quoted correctly.
      const escaped = weird.replace(/"/g, '""')
      db.exec(`CREATE TABLE "${escaped}" (v INTEGER); INSERT INTO "${escaped}" VALUES (42);`)
      db.exec(`CREATE TABLE ok (v INTEGER); INSERT INTO ok VALUES (1);`)
    })
    const sheets = await importSql(makeSqliteFile(bytes))
    const names = sheets.map((s) => s.name)
    expect(names).toContain(weird)
    expect(names).toContain('ok')
    // If the injection had succeeded, 'ok' would have been dropped.
    const okSheet = sheets.find((s) => s.name === 'ok')!
    expect(okSheet.rows).toEqual([['v'], [1]])
  })

  it('exposes typed column values (integer stays integer, text stays text)', async () => {
    const bytes = buildDb((db) => {
      db.exec(`CREATE TABLE mix (n INTEGER, s TEXT, r REAL);
               INSERT INTO mix VALUES (1, 'a', 1.5), (2, 'b', 2.5);`)
    })
    const sheets = await importSql(makeSqliteFile(bytes))
    expect(sheets[0].rows).toEqual([
      ['n', 's', 'r'],
      [1, 'a', 1.5],
      [2, 'b', 2.5],
    ])
  })

  it('surfaces NULL cells as null (not the string "null" or empty)', async () => {
    const bytes = buildDb((db) => {
      db.exec(`CREATE TABLE t (id INTEGER, name TEXT);
               INSERT INTO t VALUES (1, NULL), (2, 'ok');`)
    })
    const sheets = await importSql(makeSqliteFile(bytes))
    expect(sheets[0].rows[1]).toEqual([1, null])
    expect(sheets[0].rows[2]).toEqual([2, 'ok'])
  })

  it('surfaces BLOB cells as Uint8Array (app-level normalizeCell later tags them)', async () => {
    const bytes = buildDb((db) => {
      db.exec(`CREATE TABLE b (id INTEGER, payload BLOB);
               INSERT INTO b VALUES (1, x'48656C6C6F');`)
    })
    const sheets = await importSql(makeSqliteFile(bytes))
    const payload = sheets[0].rows[1][1]
    expect(payload).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(payload as Uint8Array)).toBe('Hello')
  })

  it('treats a 0-byte .sqlite file as an empty database (no tables)', async () => {
    // sql.js interprets zero bytes as "no prior DB → start fresh". The
    // importer surfaces that as an empty sheet list rather than throwing.
    // Pinned here so a future change that switches to stricter header
    // validation will show up explicitly.
    const sheets = await importSql(makeSqliteFile(new Uint8Array(0)))
    expect(sheets).toEqual([])
  })

  it('rejects a truncated .sqlite (partial header only)', async () => {
    // First 8 bytes of the 16-byte magic, then nothing. sql.js refuses to
    // open the page store.
    const truncated = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66])
    await expect(importSql(makeSqliteFile(truncated))).rejects.toThrow()
  })

  it('rejects a file with a valid header but corrupt page data', async () => {
    // Full 16-byte magic followed by garbage where sql.js expects
    // well-formed pages. The open may succeed but the first read throws.
    const magic = [
      0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66,
      0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
    ]
    const junk = new Array(4096 - magic.length).fill(0xff)
    const corrupted = new Uint8Array([...magic, ...junk])
    await expect(importSql(makeSqliteFile(corrupted))).rejects.toThrow()
  })
})

describe('importSql — text .sql dump path', () => {
  function makeSqlFile(text: string, name = 'in.sql'): File {
    return new File([text], name, { type: 'application/sql' })
  }

  it('runs the dialect normalizer on a mysqldump-flavoured input', async () => {
    const dump = `
      CREATE TABLE \`users\` (
        \`id\` int(11) NOT NULL AUTO_INCREMENT,
        \`email\` varchar(255),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      INSERT INTO \`users\` VALUES (1,'alice@example.com'),(2,'bob@example.com');
    `
    const sheets = await importSql(makeSqlFile(dump))
    expect(sheets).toEqual([
      {
        name: 'users',
        rows: [
          ['id', 'email'],
          [1, 'alice@example.com'],
          [2, 'bob@example.com'],
        ],
      },
    ])
  })

  it('returns [] for a .sql that only defines tables (no user tables loaded)', async () => {
    const sheets = await importSql(makeSqlFile(''))
    expect(sheets).toEqual([])
  })

  it('refuses dumps that exceed the statement cap', async () => {
    // 50_001 trivial INSERTs. Each `(1);` is parsed by the tokenizer as one
    // statement. Building the string once is cheap; we never hand it to sql.js.
    const head = 'CREATE TABLE t (v INTEGER);\n'
    const body = 'INSERT INTO t VALUES (1);\n'.repeat(50_001)
    await expect(importSql(makeSqlFile(head + body))).rejects.toThrow(
      /SQL dump too large: 50,?002 statements/,
    )
  })
})
