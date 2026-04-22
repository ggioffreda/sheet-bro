import { describe, expect, it } from 'vitest'
import { buildWorkbookShape } from './workbook-shape'

describe('buildWorkbookShape', () => {
  it('wraps a single 2x3 sheet in the Univer snapshot shape', () => {
    const out = buildWorkbookShape([
      {
        name: 'Data',
        rows: [
          ['id', 'name', 'qty'],
          [1, 'Apple', 3],
        ],
      },
    ])

    expect(out.name).toBe('Sheet')
    expect(out.sheetOrder).toEqual(['sheet1'])
    expect(out.sheets.sheet1.name).toBe('Data')
    expect(out.sheets.sheet1.id).toBe('sheet1')
    expect(out.sheets.sheet1.cellData[0][0]).toEqual({ v: 'id' })
    expect(out.sheets.sheet1.cellData[1][1]).toEqual({ v: 'Apple' })
    expect(out.sheets.sheet1.cellData[1][2]).toEqual({ v: 3 })
  })

  it('pads rowCount to at least 1000 and columnCount to at least 26', () => {
    const out = buildWorkbookShape([{ name: 'Tiny', rows: [['a', 'b']] }])
    expect(out.sheets.sheet1.rowCount).toBeGreaterThanOrEqual(1000)
    expect(out.sheets.sheet1.columnCount).toBeGreaterThanOrEqual(26)
  })

  it('pads beyond the data when the sheet is large', () => {
    const rows = Array.from({ length: 2000 }, (_, i) => [i])
    const out = buildWorkbookShape([{ name: 'Big', rows }])
    // rows + 100 buffer when > 1000
    expect(out.sheets.sheet1.rowCount).toBe(2100)
  })

  it('pads column count beyond widest row', () => {
    const rows = [Array.from({ length: 30 }, (_, i) => `c${i}`)]
    const out = buildWorkbookShape([{ name: 'Wide', rows }])
    // cols + 10 buffer when > 26
    expect(out.sheets.sheet1.columnCount).toBe(40)
  })

  it('assigns sequential sheet ids in insertion order', () => {
    const out = buildWorkbookShape([
      { name: 'Alpha', rows: [['x']] },
      { name: 'Beta', rows: [['y']] },
      { name: 'Gamma', rows: [['z']] },
    ])
    expect(out.sheetOrder).toEqual(['sheet1', 'sheet2', 'sheet3'])
    expect(out.sheets.sheet2.name).toBe('Beta')
    expect(out.sheets.sheet3.cellData[0][0]).toEqual({ v: 'z' })
  })

  it('normalizes Date, boolean, null, and Uint8Array cells via normalizeCell', () => {
    const out = buildWorkbookShape([
      {
        name: 'Mixed',
        rows: [
          [new Date('2024-01-02T03:04:05Z'), true, null, new Uint8Array([1, 2, 3])],
        ],
      },
    ])
    const row = out.sheets.sheet1.cellData[0]
    expect(row[0].v).toBe('2024-01-02T03:04:05.000Z')
    expect(row[1].v).toBe('TRUE')
    expect(row[2].v).toBe('')
    expect(row[3].v).toBe('[BLOB: 3 bytes]')
  })

  it('handles jagged rows (short rows do not leak into neighbours)', () => {
    const out = buildWorkbookShape([
      { name: 'Jag', rows: [['a', 'b', 'c'], ['x'], ['p', 'q']] },
    ])
    const cells = out.sheets.sheet1.cellData
    expect(cells[0]).toEqual({ 0: { v: 'a' }, 1: { v: 'b' }, 2: { v: 'c' } })
    expect(cells[1]).toEqual({ 0: { v: 'x' } })
    expect(cells[2]).toEqual({ 0: { v: 'p' }, 1: { v: 'q' } })
  })

  it('produces an empty sheetOrder for an empty input list', () => {
    const out = buildWorkbookShape([])
    expect(out.sheetOrder).toEqual([])
    expect(out.sheets).toEqual({})
  })
})
