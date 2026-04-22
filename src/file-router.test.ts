import { describe, expect, it } from 'vitest'
import { importCsv, importSql, importXlsx } from './importers'
import {
  detectFileKind,
  importerForKind,
  labelForKind,
} from './file-router'

function mk(name: string, bytes: ArrayLike<number> = [], type = ''): File {
  return new File([new Uint8Array(bytes)], name, { type })
}

const XLSX_BYTES = [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]
const SQLITE_BYTES = [
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66,
  0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
]

describe('detectFileKind — magic-byte routing', () => {
  it('sniffs an XLSX by its PK\\x03\\x04 prefix even under a wrong extension', async () => {
    const f = mk('renamed.csv', XLSX_BYTES)
    expect(await detectFileKind(f)).toBe('xlsx')
  })

  it('sniffs a SQLite DB by its 16-byte header even under an unusual extension', async () => {
    const f = mk('data.db.bak', SQLITE_BYTES)
    expect(await detectFileKind(f)).toBe('sqlite')
  })

  it('falls back to extension/MIME when bytes are empty', async () => {
    expect(await detectFileKind(mk('book.xlsx'))).toBe('xlsx')
    expect(await detectFileKind(mk('data.sqlite'))).toBe('sqlite')
    expect(await detectFileKind(mk('data.db'))).toBe('sqlite')
    expect(await detectFileKind(mk('data.sqlite3'))).toBe('sqlite')
    expect(await detectFileKind(mk('dump.sql'))).toBe('sql')
    expect(await detectFileKind(mk('data.csv'))).toBe('csv')
    expect(await detectFileKind(mk('noextension'))).toBe('csv')
    expect(await detectFileKind(mk('data.txt'))).toBe('csv')
  })

  it('uses XLSX MIME to route a file with no extension', async () => {
    const f = mk(
      'noname',
      [],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    expect(await detectFileKind(f)).toBe('xlsx')
  })

  it('prefers XLSX over a misleading .sql suffix via magic bytes', async () => {
    const f = mk('weird.sql', XLSX_BYTES)
    expect(await detectFileKind(f)).toBe('xlsx')
  })
})

describe('detectFileKind — edge cases', () => {
  it('routes an extensionless file with no magic and no MIME as csv (documented fallback)', async () => {
    // No extension, no MIME, arbitrary bytes that don't match any magic.
    const f = mk('payload', [0x68, 0x65, 0x6c, 0x6c, 0x6f])
    expect(await detectFileKind(f)).toBe('csv')
  })

  it('routes a 0-byte file with .sqlite extension as sqlite via extension fallback', async () => {
    // readHead yields an empty Uint8Array; neither magic matches; extension
    // decides.
    const f = mk('empty.sqlite', [])
    expect(await detectFileKind(f)).toBe('sqlite')
  })

  it('routes a 0-byte file with no extension as csv', async () => {
    const f = mk('empty', [])
    expect(await detectFileKind(f)).toBe('csv')
  })

  it('routes a tiny .xlsx file with no PK magic as xlsx via extension fallback', async () => {
    // <4 bytes so the PK\x03\x04 prefix cannot match, but the extension
    // still routes it to the xlsx importer.
    const f = mk('tiny.xlsx', [0x00])
    expect(await detectFileKind(f)).toBe('xlsx')
  })

  it('ignores a partial SQLite magic (requires all 16 bytes)', async () => {
    // "SQLite" prefix only — 6 bytes of the 16-byte magic. No extension
    // means it should fall through to the csv default rather than
    // half-matching.
    const partial = [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65]
    const f = mk('mystery', partial)
    expect(await detectFileKind(f)).toBe('csv')
  })
})

describe('importerForKind', () => {
  it('maps each kind to the matching importer', () => {
    // Identity assertion retained as a fast smoke check — the behavioral
    // test below is what guards against routing regressions.
    expect(importerForKind('xlsx')).toBe(importXlsx)
    expect(importerForKind('sqlite')).toBe(importSql)
    expect(importerForKind('sql')).toBe(importSql)
    expect(importerForKind('csv')).toBe(importCsv)
  })

  it('returns an importer that actually parses for its kind (behavioral check)', async () => {
    // Feeding plain CSV bytes into the 'csv' importer must produce the
    // expected sheet shape. If the mapping were silently rerouted to a
    // different importer (xlsx / sql), this call would throw instead of
    // returning the parsed rows. Non-csv kinds are left to the identity
    // check above — invoking them here would load WASM / parsers that
    // happy-dom can't serve, and their behavior is exercised in the
    // dedicated per-importer tests.
    const csvSheets = await importerForKind('csv')(
      mk('a.csv', [0x61, 0x2c, 0x62, 0x0a, 0x31, 0x2c, 0x32]),
    )
    expect(csvSheets).toHaveLength(1)
    expect(csvSheets[0].rows).toEqual([['a', 'b'], [1, 2]])
  })
})

describe('labelForKind', () => {
  it.each([
    ['xlsx', 'XLSX file'],
    ['sqlite', 'SQLite database'],
    ['sql', 'SQL dump'],
    ['csv', 'CSV file'],
  ] as const)('labels kind %s as %s', (kind, label) => {
    expect(labelForKind(kind)).toBe(label)
  })
})
