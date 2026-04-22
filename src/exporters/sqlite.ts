import type { SqlJsStatic } from 'sql.js'
import type { createUniver } from '@univerjs/presets'
import { loadSqlJs } from '../sqljs'
import {
  collectTableSpecs,
  downloadBlob,
  quoteIdent,
  type ExportCell,
  type TableSpec,
} from './shared'

type UniverAPI = ReturnType<typeof createUniver>['univerAPI']

export function buildDbBytes(SQL: SqlJsStatic, specs: TableSpec[]): Uint8Array {
  const db = new SQL.Database()
  try {
    db.exec('BEGIN TRANSACTION')
    for (const spec of specs) {
      const colDefs = spec.columns
        .map((c) => `${quoteIdent(c.name)} ${c.type}`)
        .join(', ')
      db.exec(`DROP TABLE IF EXISTS ${quoteIdent(spec.tableName)}`)
      db.exec(`CREATE TABLE ${quoteIdent(spec.tableName)} (${colDefs})`)
      if (spec.rows.length === 0) continue
      const placeholders = spec.columns.map(() => '?').join(', ')
      const stmt = db.prepare(
        `INSERT INTO ${quoteIdent(spec.tableName)} VALUES (${placeholders})`,
      )
      try {
        for (const row of spec.rows) {
          stmt.run(row.map(forBind) as Parameters<typeof stmt.run>[0])
        }
      } finally {
        stmt.free()
      }
    }
    db.exec('COMMIT')
    return db.export()
  } finally {
    db.close()
  }
}

function forBind(cell: ExportCell): string | number | null {
  if (cell === null) return null
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE'
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null
  return cell.replace(/\x00/g, '')
}

export type SqliteExportResult = { tableCount: number; generatedHeaderCount: number }

export async function buildSqliteExport(api: UniverAPI, stem?: string): Promise<{ bytes: Uint8Array; filename: string; meta: SqliteExportResult } | null> {
  const wb = api.getActiveWorkbook()
  if (!wb) return null
  const specs = collectTableSpecs(wb)
  if (specs.length === 0) return null
  const SQL = await loadSqlJs()
  const bytes = buildDbBytes(SQL, specs)
  return {
    bytes,
    filename: `${stem ?? 'workbook'}.sqlite`,
    meta: {
      tableCount: specs.length,
      generatedHeaderCount: specs.filter((s) => s.usedGeneratedHeader).length,
    },
  }
}

export async function exportSqlite(api: UniverAPI, stem?: string): Promise<SqliteExportResult> {
  const result = await buildSqliteExport(api, stem)
  if (!result) return { tableCount: 0, generatedHeaderCount: 0 }
  downloadBlob(
    new Blob([result.bytes as BlobPart], { type: 'application/vnd.sqlite3' }),
    result.filename,
  )
  return result.meta
}
