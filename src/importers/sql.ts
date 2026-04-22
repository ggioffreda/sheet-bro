import type { Database } from 'sql.js'
import type { CellPrimitive, LoadedSheet } from './index'
import { loadSqlJs } from '../sqljs'
import { normalizeToSqliteStatements } from './sql-dialect'
import { UserFacingError } from '../user-facing-error'

// Defense-in-depth cap on how many statements a dropped .sql dump may
// execute. sql.js runs in-process and on the main thread; a 10-million-
// statement file would freeze the tab. The cap is intentionally generous
// (real dumps rarely exceed a few hundred thousand) but finite.
const MAX_SQL_STATEMENTS = 50_000

export function isSqliteFile(file: File): boolean {
  return /\.(sqlite3?|db)$/i.test(file.name)
}

export function isSqlDumpFile(file: File): boolean {
  return /\.sql$/i.test(file.name)
}

export async function importSql(file: File): Promise<LoadedSheet[]> {
  if (isSqlDumpFile(file)) return parseSqlDump(await file.text())
  return parseSqliteBytes(new Uint8Array(await file.arrayBuffer()))
}

export async function parseSqlDump(text: string): Promise<LoadedSheet[]> {
  const SQL = await loadSqlJs()
  const statements = normalizeToSqliteStatements(text)
  if (statements.length > MAX_SQL_STATEMENTS) {
    throw new UserFacingError(
      `SQL dump too large: ${statements.length} statements ` +
        `(cap ${MAX_SQL_STATEMENTS.toLocaleString('en-US')}).`,
    )
  }
  const db = new SQL.Database()
  try {
    db.exec(statements.join('\n'))
    return readAllTables(db)
  } finally {
    db.close()
  }
}

export async function parseSqliteBytes(bytes: Uint8Array): Promise<LoadedSheet[]> {
  const SQL = await loadSqlJs()
  const db = new SQL.Database(bytes)
  try {
    return readAllTables(db)
  } finally {
    db.close()
  }
}

function readAllTables(db: Database): LoadedSheet[] {
  const list = db.exec(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  if (list.length === 0) return []
  const names = list[0].values.map((r) => String(r[0]))
  return names.map((name) => {
    const quoted = '"' + name.replace(/"/g, '""') + '"'
    const res = db.exec(`SELECT * FROM ${quoted}`)
    if (res.length === 0) return { name, rows: [] }
    const { columns, values } = res[0]
    const rows: CellPrimitive[][] = [columns.slice(), ...values.map((r) => r.slice() as CellPrimitive[])]
    return { name, rows }
  })
}
