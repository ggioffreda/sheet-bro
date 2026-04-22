import type { createUniver } from '@univerjs/presets'
import {
  collectTableSpecs,
  downloadBlob,
  quoteIdent,
  sqlStringLiteral,
  type ExportCell,
  type TableSpec,
} from './shared'

type UniverAPI = ReturnType<typeof createUniver>['univerAPI']

const BATCH = 500

export function buildSqlText(specs: TableSpec[]): string {
  const out: string[] = []
  out.push('-- sheet-bro export')
  out.push('BEGIN TRANSACTION;')
  for (const spec of specs) {
    out.push('')
    out.push(`DROP TABLE IF EXISTS ${quoteIdent(spec.tableName)};`)
    const colDefs = spec.columns
      .map((c) => `  ${quoteIdent(c.name)} ${c.type}`)
      .join(',\n')
    out.push(`CREATE TABLE ${quoteIdent(spec.tableName)} (\n${colDefs}\n);`)
    if (spec.rows.length === 0) continue
    for (let i = 0; i < spec.rows.length; i += BATCH) {
      const batch = spec.rows.slice(i, i + BATCH)
      const values = batch.map((row) => '  (' + row.map(sqlLiteral).join(', ') + ')').join(',\n')
      out.push(`INSERT INTO ${quoteIdent(spec.tableName)} VALUES\n${values};`)
    }
  }
  out.push('COMMIT;')
  return out.join('\n') + '\n'
}

function sqlLiteral(cell: ExportCell): string {
  if (cell === null) return 'NULL'
  if (typeof cell === 'number') return Number.isFinite(cell) ? String(cell) : 'NULL'
  if (typeof cell === 'boolean') return cell ? '1' : '0'
  // String — strip NUL bytes (trip up some SQL clients), then literal.
  const cleaned = cell.replace(/\x00/g, '')
  return sqlStringLiteral(cleaned)
}

export type SqlExportResult = { tableCount: number; generatedHeaderCount: number }

function buildSqlData(api: UniverAPI, stem?: string): { text: string; filename: string; meta: SqlExportResult } | null {
  const wb = api.getActiveWorkbook()
  if (!wb) return null
  const specs = collectTableSpecs(wb)
  if (specs.length === 0) return null
  return {
    text: buildSqlText(specs),
    filename: `${stem ?? 'workbook'}.sql`,
    meta: {
      tableCount: specs.length,
      generatedHeaderCount: specs.filter((s) => s.usedGeneratedHeader).length,
    },
  }
}

export function buildSqlExport(api: UniverAPI, stem?: string): { bytes: Uint8Array; filename: string; meta: SqlExportResult } | null {
  const data = buildSqlData(api, stem)
  if (!data) return null
  return { bytes: new TextEncoder().encode(data.text), filename: data.filename, meta: data.meta }
}

export function exportSql(api: UniverAPI, stem?: string): SqlExportResult {
  const data = buildSqlData(api, stem)
  if (!data) return { tableCount: 0, generatedHeaderCount: 0 }
  downloadBlob(new Blob([data.text], { type: 'application/sql;charset=utf-8' }), data.filename)
  return data.meta
}
