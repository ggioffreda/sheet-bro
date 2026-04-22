import { describe, expect, it, vi } from 'vitest'
import { dispatchParserJob } from './parser.worker'
import { UserFacingError } from '../user-facing-error'

// The heavy parsers are mocked so these tests exercise only the
// dispatcher branching and error-shape contract. Round-trip coverage of
// the actual parsers already lives in src/importers/sql.test.ts and
// src/importers/sql-dialect.test.ts.
vi.mock('../importers/sql', () => ({
  parseSqlDump: vi.fn(async (text: string) => {
    if (text === '__user__') throw new UserFacingError('user-facing boom')
    if (text === '__raw__') throw new Error('internal boom')
    if (text === '__nonerror__') throw 'weird'
    return [{ name: 'dump', rows: [['id'], [1]] }]
  }),
  parseSqliteBytes: vi.fn(async () => [{ name: 'sqlite', rows: [['n'], [2]] }]),
}))

function sqliteHeader(): Uint8Array {
  const s = 'SQLite format 3\0'
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

describe('dispatchParserJob', () => {
  it('returns sheets for a sql-dump job', async () => {
    const r = await dispatchParserJob({ job: 'sql-dump', text: 'x' })
    expect(r).toEqual({ ok: true, sheets: [{ name: 'dump', rows: [['id'], [1]] }] })
  })

  it('returns sheets for a sqlite job', async () => {
    const r = await dispatchParserJob({ job: 'sqlite', bytes: sqliteHeader() })
    expect(r).toEqual({ ok: true, sheets: [{ name: 'sqlite', rows: [['n'], [2]] }] })
  })

  it('rejects a sqlite job whose bytes do not start with the SQLite magic', async () => {
    const r = await dispatchParserJob({ job: 'sqlite', bytes: new Uint8Array([0x00, 0x01, 0x02]) })
    expect(r).toEqual({ ok: false, userFacing: true, message: 'File type mismatch — refusing to parse.' })
  })

  it('rejects a sql-dump job whose text looks like a binary blob', async () => {
    // Feed the string form of the XLSX (ZIP) magic — the defensive magic-byte
    // re-check in the worker must refuse rather than hand it to parseSqlDump.
    const xlsxLike = '\x50\x4b\x03\x04some-zip-body'
    const r = await dispatchParserJob({ job: 'sql-dump', text: xlsxLike })
    expect(r).toEqual({ ok: false, userFacing: true, message: 'File type mismatch — refusing to parse.' })
  })

  it('marks UserFacingError results as userFacing: true', async () => {
    const r = await dispatchParserJob({ job: 'sql-dump', text: '__user__' })
    expect(r).toEqual({ ok: false, userFacing: true, message: 'user-facing boom' })
  })

  it('marks plain Errors as userFacing: false', async () => {
    const r = await dispatchParserJob({ job: 'sql-dump', text: '__raw__' })
    expect(r).toEqual({ ok: false, userFacing: false, message: 'internal boom' })
  })

  it('stringifies non-Error throws', async () => {
    const r = await dispatchParserJob({ job: 'sql-dump', text: '__nonerror__' })
    expect(r).toEqual({ ok: false, userFacing: false, message: 'weird' })
  })
})
