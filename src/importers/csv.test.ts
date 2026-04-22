import { describe, expect, it, vi } from 'vitest'
import { importCsv } from './csv'

function makeCsv(body: string, name = 'data.csv'): File {
  return new File([body], name, { type: 'text/csv' })
}

describe('importCsv', () => {
  it('parses a simple 2x3 sheet and coerces numeric cells to Number', async () => {
    const sheets = await importCsv(makeCsv('id,name,qty\n1,Apple,3\n2,Pear,5\n'))
    expect(sheets).toHaveLength(1)
    expect(sheets[0]).toEqual({
      name: 'Sheet1',
      rows: [
        ['id', 'name', 'qty'],
        [1, 'Apple', 3],
        [2, 'Pear', 5],
      ],
    })
  })

  it('keeps empty cells as the empty string rather than coercing to 0', async () => {
    const sheets = await importCsv(makeCsv('a,b,c\n1,,3\n'))
    expect(sheets[0].rows[1]).toEqual([1, '', 3])
  })

  it('preserves non-numeric strings verbatim', async () => {
    const sheets = await importCsv(makeCsv('id,kind\n1,premium\n2,trial\n'))
    expect(sheets[0].rows[1]).toEqual([1, 'premium'])
    expect(sheets[0].rows[2]).toEqual([2, 'trial'])
  })

  it('decodes quoted fields containing commas, quotes, and newlines', async () => {
    const body = 'id,note\n1,"a,b"\n2,"she said ""hi"""\n3,"multi\nline"\n'
    const sheets = await importCsv(makeCsv(body))
    expect(sheets[0].rows).toEqual([
      ['id', 'note'],
      [1, 'a,b'],
      [2, 'she said "hi"'],
      [3, 'multi\nline'],
    ])
  })

  it('skips fully empty lines', async () => {
    const body = 'a,b\n1,2\n\n3,4\n\n'
    const sheets = await importCsv(makeCsv(body))
    expect(sheets[0].rows).toEqual([
      ['a', 'b'],
      [1, 2],
      [3, 4],
    ])
  })

  it('handles a BOM-prefixed file without leaking it into row 0', async () => {
    const body = '\uFEFFid,name\n1,Apple\n'
    const sheets = await importCsv(makeCsv(body))
    expect(sheets[0].rows[0]).toEqual(['id', 'name'])
  })

  it('returns an empty rows array for an empty file', async () => {
    const sheets = await importCsv(makeCsv(''))
    expect(sheets).toEqual([{ name: 'Sheet1', rows: [] }])
  })

  it('supports a single-column file', async () => {
    const sheets = await importCsv(makeCsv('email\nalice@example.com\nbob@example.com\n'))
    expect(sheets[0].rows).toEqual([
      ['email'],
      ['alice@example.com'],
      ['bob@example.com'],
    ])
  })

  it('treats strings like "1e3" as numbers (JS Number semantics)', async () => {
    // Documents current behaviour: coerceCsvCell uses Number() so scientific
    // notation coerces. The typed-column exporter later re-classifies and may
    // still produce REAL or TEXT as appropriate — that divergence is covered
    // by inferColumnType tests, not here.
    const sheets = await importCsv(makeCsv('v\n1e3\n'))
    expect(sheets[0].rows[1]).toEqual([1000])
  })

  it('keeps leading-zero strings as numbers at import time (documents lossy step)', async () => {
    // Known lossy behaviour of coerceCsvCell: Number("007") → 7. The
    // exporter-side inferColumnType is the layer that decides whether to
    // preserve such columns as TEXT, but that decision is made on the
    // *stringified* Univer cell, not on the importer output.
    const sheets = await importCsv(makeCsv('zip\n007\n'))
    expect(sheets[0].rows[1]).toEqual([7])
  })

  it('propagates a parser error via the rejected promise', async () => {
    // Force Papa to reject by handing it a non-File/non-string argument.
    // The importer's Promise should reject rather than resolve with garbage.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = undefined as unknown as File
    await expect(importCsv(bad)).rejects.toBeDefined()
  })

  it('tolerates unterminated quoted fields (PapaParse recovers silently)', async () => {
    // PapaParse is permissive with broken quotes: it treats the unterminated
    // quote as the start of a long quoted field that runs to EOF. We pin
    // that behaviour rather than trying to reject — a future change to
    // stricter parsing would fail this test and force an explicit decision.
    const sheets = await importCsv(makeCsv('a,b,c\n1,"unterminated,2\n'))
    expect(sheets).toHaveLength(1)
    expect(sheets[0].rows[0]).toEqual(['a', 'b', 'c'])
    // The second row survives (the quoted value swallows the rest of the
    // line). The exact recovered shape depends on Papa internals; all we
    // care about here is "no throw".
    expect(sheets[0].rows.length).toBeGreaterThanOrEqual(1)
  })

  it('emits rows with mixed column counts verbatim (no padding, no dropping)', async () => {
    const sheets = await importCsv(makeCsv('a,b,c\n1,2\n3,4,5,6\n'))
    expect(sheets[0].rows).toEqual([
      ['a', 'b', 'c'],
      [1, 2],
      [3, 4, 5, 6],
    ])
  })

  it('auto-detects semicolon delimiters (PapaParse default behaviour)', async () => {
    // The importer does not pin a `delimiter` option, so Papa's own
    // auto-detection runs. Semicolon files split into separate cells.
    // Pinned here as a regression guard: flipping auto-detection off (e.g.
    // `delimiter: ','`) would make these land in a single cell and this
    // assertion would fail, forcing an explicit decision.
    const sheets = await importCsv(makeCsv('a;b;c\n1;2;3\n'))
    expect(sheets[0].rows).toEqual([
      ['a', 'b', 'c'],
      [1, 2, 3],
    ])
  })

  it('rejects when PapaParse invokes its error callback mid-parse', async () => {
    // The synchronous-throw path (above) bypasses PapaParse's `error` hook;
    // this test drives the async error branch — verifying `error: (err) =>
    // reject(err)` wires callback-style failures back into the promise.
    const papa = await import('papaparse')
    const spy = vi
      .spyOn(papa.default, 'parse')
      .mockImplementation((...args: unknown[]) => {
        const opts = args[1] as { error?: (e: unknown) => void }
        queueMicrotask(() => opts.error?.(new Error('simulated papa failure')))
        return undefined as unknown as ReturnType<typeof papa.default.parse>
      })
    await expect(importCsv(new File(['a,b'], 'x.csv'))).rejects.toThrow(
      /simulated papa failure/,
    )
    spy.mockRestore()
  })
})
