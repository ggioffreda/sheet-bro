import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readMock } = vi.hoisted(() => ({ readMock: vi.fn() }))
vi.mock('read-excel-file/browser', () => ({ default: readMock }))

import { importXlsx, isValidXlsxSheetData, isXlsxFile } from './xlsx'
import { UserFacingError } from '../user-facing-error'

// Round-trip testing (write → read) of XLSX blobs is intentionally out of
// scope here: the write-excel-file/read-excel-file pair generates a zip
// container that depends on browser-native Blob/streaming internals that
// happy-dom does not faithfully reproduce. Those round-trips belong to the
// Playwright E2E layer. We mock read-excel-file at the module boundary to
// verify the importer's mapping logic.

describe('isXlsxFile', () => {
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

  it.each([
    ['book.xlsx', '', true],
    ['book.XLSX', '', true],
    ['mixed.XlsX', '', true],
    ['nameless', XLSX_MIME, true], // MIME-only branch
    ['', XLSX_MIME, true],
    ['book.xls', '', false],
    ['book.csv', '', false],
    ['book.xlsx.bak', '', false],
    ['book.xls', XLSX_MIME, true], // MIME wins over wrong extension
    ['anything', 'application/octet-stream', false],
    ['anything', '', false],
  ])('isXlsxFile({ name=%j, type=%j }) → %s', (name, type, expected) => {
    expect(isXlsxFile(new File([], name, { type }))).toBe(expected)
  })
})

describe('importXlsx', () => {
  beforeEach(() => readMock.mockReset())

  it('maps a single-sheet parse result to one LoadedSheet', async () => {
    readMock.mockResolvedValue([
      {
        sheet: 'Sheet1',
        data: [
          ['id', 'name', 'qty'],
          [1, 'Apple', 3],
          [2, 'Pear', 5],
        ],
      },
    ])
    const sheets = await importXlsx(new File([], 'ignored.xlsx'))
    expect(sheets).toEqual([
      {
        name: 'Sheet1',
        rows: [
          ['id', 'name', 'qty'],
          [1, 'Apple', 3],
          [2, 'Pear', 5],
        ],
      },
    ])
  })

  it('preserves multi-sheet order', async () => {
    readMock.mockResolvedValue([
      { sheet: 'First', data: [['a'], [1]] },
      { sheet: 'Second', data: [['b'], [2]] },
    ])
    const sheets = await importXlsx(new File([], 'book.xlsx'))
    expect(sheets.map((s) => s.name)).toEqual(['First', 'Second'])
  })

  it('rejects sheets containing non-primitive cells with a UserFacingError', async () => {
    readMock.mockResolvedValue([
      { sheet: 'Weird', data: [['ok', { unexpected: true }]] },
    ])
    await expect(importXlsx(new File([], 'bad.xlsx'))).rejects.toBeInstanceOf(UserFacingError)
  })

  it('rejects sheets whose data is not an array-of-arrays', async () => {
    readMock.mockResolvedValue([
      { sheet: 'Broken', data: 'not-a-grid' as unknown },
    ])
    await expect(importXlsx(new File([], 'bad.xlsx'))).rejects.toBeInstanceOf(UserFacingError)
  })

  it('forwards typed cells (Date, boolean, null) verbatim to the caller', async () => {
    const when = new Date('2024-01-02T03:04:05Z')
    readMock.mockResolvedValue([
      { sheet: 'S', data: [['t', 'b', 'n'], [when, true, null]] },
    ])
    const sheets = await importXlsx(new File([], 'x.xlsx'))
    expect(sheets[0].rows[1]).toEqual([when, true, null])
  })
})

describe('isValidXlsxSheetData', () => {
  it('accepts empty grids', () => {
    expect(isValidXlsxSheetData([])).toBe(true)
    expect(isValidXlsxSheetData([[]])).toBe(true)
  })

  it('accepts supported primitive cell types', () => {
    expect(isValidXlsxSheetData([[1, 'a', true, null, new Date()]])).toBe(true)
  })

  it('rejects a non-array top level', () => {
    expect(isValidXlsxSheetData('nope')).toBe(false)
    expect(isValidXlsxSheetData(null)).toBe(false)
    expect(isValidXlsxSheetData({})).toBe(false)
  })

  it('rejects a row that is not an array', () => {
    expect(isValidXlsxSheetData([['ok'], 'broken' as unknown])).toBe(false)
  })

  it('rejects a row with an unexpected cell type', () => {
    expect(isValidXlsxSheetData([[{ x: 1 }]])).toBe(false)
    expect(isValidXlsxSheetData([[new Uint8Array(1)]])).toBe(false)
    expect(isValidXlsxSheetData([[undefined]])).toBe(false)
  })
})
