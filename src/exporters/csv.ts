import type { createUniver } from '@univerjs/presets'
import { downloadBlob, sanitizeFilename, sheetToRowsCsvSafe, type ExportCell } from './shared'

type UniverAPI = ReturnType<typeof createUniver>['univerAPI']

// Pure CSV formatter: null → empty string, everything else handed to
// PapaParse for quoting/escaping. Kept separate from exportCsv so tests can
// exercise null-handling and embedded-special quoting without needing a
// Univer workbook.
export async function formatCsv(rows: ExportCell[][]): Promise<string> {
  const { default: Papa } = await import('papaparse')
  return Papa.unparse(rows.map((row) => row.map((c) => (c === null ? '' : c))))
}

async function buildCsvData(api: UniverAPI, stem?: string): Promise<{ csv: string; filename: string } | null> {
  const wb = api.getActiveWorkbook()
  if (!wb) return null
  const sheet = wb.getActiveSheet()
  const rows = sheetToRowsCsvSafe(sheet)
  return {
    csv: await formatCsv(rows),
    filename: `${stem ?? sanitizeFilename(sheet.getSheetName())}.csv`,
  }
}

export async function buildCsvExport(api: UniverAPI, stem?: string): Promise<{ bytes: Uint8Array; filename: string } | null> {
  const data = await buildCsvData(api, stem)
  if (!data) return null
  return { bytes: new TextEncoder().encode(data.csv), filename: data.filename }
}

export async function exportCsv(api: UniverAPI, stem?: string): Promise<void> {
  const data = await buildCsvData(api, stem)
  if (!data) return
  downloadBlob(new Blob([data.csv], { type: 'text/csv;charset=utf-8' }), data.filename)
}
