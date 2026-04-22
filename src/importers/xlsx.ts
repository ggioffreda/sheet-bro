import type { CellPrimitive, LoadedSheet } from './index'
import { UserFacingError } from '../user-facing-error'

export function isXlsxFile(file: File): boolean {
  if (/\.xlsx$/i.test(file.name)) return true
  return file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
}

// read-excel-file yields only string|number|boolean|Date|null.
// CellPrimitive also permits Uint8Array for the SQL import path, but that
// never occurs from XLSX — the narrower guard is deliberate.
export function isValidXlsxSheetData(data: unknown): data is CellPrimitive[][] {
  return (
    Array.isArray(data) &&
    data.every((row) =>
      Array.isArray(row) &&
      row.every((c) =>
        c === null ||
        typeof c === 'string' ||
        typeof c === 'number' ||
        typeof c === 'boolean' ||
        c instanceof Date,
      ),
    )
  )
}

export async function importXlsx(file: File): Promise<LoadedSheet[]> {
  const { default: readXlsxFile } = await import('read-excel-file/browser')
  const sheets = await readXlsxFile(file)
  return sheets.map(({ sheet, data }) => {
    if (!isValidXlsxSheetData(data)) {
      throw new UserFacingError(`Sheet "${sheet}" contained unexpected cell types.`)
    }
    return { name: sheet, rows: data }
  })
}
