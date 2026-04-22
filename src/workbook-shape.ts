import type { LoadedSheet } from './importers'
import { normalizeCell } from './cell'

export interface WorkbookShape {
  name: string
  sheets: Record<
    string,
    {
      id: string
      name: string
      rowCount: number
      columnCount: number
      cellData: Record<number, Record<number, { v: string | number }>>
    }
  >
  sheetOrder: string[]
}

// Pure sheet → Univer workbook-snapshot shape. Each loaded sheet becomes a
// `sheetN` id, cells are run through `normalizeCell` to land in Univer's
// string|number cell value type, and the row/column counts are padded so the
// grid isn't claustrophobic around the data. Extracted from app.ts so the
// shape math (especially the `Math.max(rows + 100, 1000)` / `cols + 10, 26`
// padding) has a unit-testable seam — regressions there would be invisible
// until a user drags a 500-row file onto the page.
export function buildWorkbookShape(sheets: LoadedSheet[]): WorkbookShape {
  const sheetsObj: WorkbookShape['sheets'] = {}
  const sheetOrder: string[] = []
  sheets.forEach((sheet, index) => {
    const id = `sheet${index + 1}`
    const cols = sheet.rows.reduce((m, r) => Math.max(m, r.length), 0)
    const cellData: Record<number, Record<number, { v: string | number }>> = {}
    sheet.rows.forEach((row, r) => {
      const rowObj: Record<number, { v: string | number }> = {}
      row.forEach((cell, c) => {
        rowObj[c] = { v: normalizeCell(cell) }
      })
      cellData[r] = rowObj
    })
    sheetsObj[id] = {
      id,
      name: sheet.name,
      rowCount: Math.max(sheet.rows.length + 100, 1000),
      columnCount: Math.max(cols + 10, 26),
      cellData,
    }
    sheetOrder.push(id)
  })
  return { name: 'Sheet', sheets: sheetsObj, sheetOrder }
}
