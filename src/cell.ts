import type { CellPrimitive } from './importers'

// Single coercion funnel from importer-level CellPrimitive
// (string | number | boolean | Date | Uint8Array | null) into the cell value
// type Univer accepts in its workbook snapshot (string | number). Keep
// symmetric with exporter-side coercion (see exporters/shared.ts).
export function normalizeCell(cell: CellPrimitive): string | number {
  if (cell === null || cell === undefined) return ''
  if (cell instanceof Date) return cell.toISOString()
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE'
  if (cell instanceof Uint8Array) return `[BLOB: ${cell.byteLength} bytes]`
  return cell
}
