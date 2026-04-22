import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildCsvExport, exportCsv, formatCsv } from './csv'
import { csvSafe } from './shared'
import {
  buildFakeUniverAPI,
  captureDownloads,
  readBlobText,
  type DownloadCapture,
} from '../test-helpers/fake-univer'

describe('formatCsv', () => {
  it('emits a basic header + rows', async () => {
    expect(await formatCsv([
      ['id', 'name'],
      ['1', 'Alice'],
      ['2', 'Bob'],
    ])).toBe('id,name\r\n1,Alice\r\n2,Bob')
  })

  it('substitutes null with an empty cell', async () => {
    expect(await formatCsv([
      ['a', 'b', 'c'],
      [null, '1', null],
    ])).toBe('a,b,c\r\n,1,')
  })

  it('quotes cells containing commas', async () => {
    expect(await formatCsv([['a'], ['x,y']])).toBe('a\r\n"x,y"')
  })

  it('quotes cells containing double quotes and escapes the inner quote', async () => {
    expect(await formatCsv([['a'], ['she said "hi"']])).toBe('a\r\n"she said ""hi"""')
  })

  it('quotes cells containing newlines', async () => {
    expect(await formatCsv([['a'], ['line1\nline2']])).toBe('a\r\n"line1\nline2"')
  })

  it('round-trips numbers and booleans as strings', async () => {
    expect(await formatCsv([['n', 'b'], [42, true], [0, false]])).toBe('n,b\r\n42,true\r\n0,false')
  })

  it('serializes an empty 2D array as an empty string', async () => {
    expect(await formatCsv([])).toBe('')
  })

  it('composes safely with csvSafe — a formula payload becomes a leading-apostrophe string', async () => {
    // The exporter applies csvSafe before calling formatCsv via
    // sheetToRowsCsvSafe(). Verify the composition end-to-end to prevent a
    // future "simplification" from dropping the injection defense.
    const raw = [['danger'], ['=SUM(A1)'], ['-99'], ['@rce']]
    const safe = raw.map((r) => r.map((c) => csvSafe(c)))
    expect(await formatCsv(safe)).toBe('danger\r\n\'=SUM(A1)\r\n\'-99\r\n\'@rce')
  })
})

describe('buildCsvExport', () => {
  it('returns bytes and filename for active sheet', async () => {
    const api = buildFakeUniverAPI([
      { name: 'Report', rows: [['a', 'b'], [1, 2]] },
    ])
    const result = await buildCsvExport(api)
    expect(result).not.toBeNull()
    expect(result!.filename).toBe('Report.csv')
    const text = new TextDecoder().decode(result!.bytes)
    expect(text).toContain('a,b')
  })

  it('returns null when there is no active workbook', async () => {
    const api = buildFakeUniverAPI(null)
    expect(await buildCsvExport(api)).toBeNull()
  })
})

describe('exportCsv (wrapper)', () => {
  let capture: DownloadCapture
  beforeEach(() => { capture = captureDownloads() })
  afterEach(() => capture.uninstall())

  it('downloads the active sheet as CSV with a sanitized filename', async () => {
    const api = buildFakeUniverAPI([
      { name: 'Orders', rows: [['id', 'total'], [1, 99], [2, 50]] },
    ])
    await exportCsv(api)
    expect(capture.calls).toHaveLength(1)
    expect(capture.calls[0].fileName).toBe('Orders.csv')
    const text = await readBlobText(capture.calls[0].blob)
    expect(text.split(/\r?\n/)).toEqual(['id,total', '1,99', '2,50'])
  })

  it('applies csvSafe to injection payloads before writing', async () => {
    const api = buildFakeUniverAPI([
      { name: 'Bad', rows: [['payload'], ['=RCE()'], ['+1+1'], ['@x']] },
    ])
    await exportCsv(api)
    const text = await readBlobText(capture.calls[0].blob)
    // Every risky cell is prefixed with a single quote.
    expect(text).toContain("'=RCE()")
    expect(text).toContain("'+1+1")
    expect(text).toContain("'@x")
  })

  it('falls back to "sheet.csv" when the sheet name is empty', async () => {
    const api = buildFakeUniverAPI([
      { name: '', rows: [['x'], ['1']] },
    ])
    await exportCsv(api)
    expect(capture.calls[0].fileName).toBe('sheet.csv')
  })

  it('is a no-op when there is no active workbook', async () => {
    const api = buildFakeUniverAPI(null)
    await exportCsv(api)
    expect(capture.calls).toHaveLength(0)
  })
})
