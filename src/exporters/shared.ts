import type { createUniver } from '@univerjs/presets'

export type ExportCell = string | number | boolean | null
export type ColumnType = 'INTEGER' | 'REAL' | 'TEXT'
export type ColumnSpec = { name: string; type: ColumnType }

export type TableSpec = {
  tableName: string
  columns: ColumnSpec[]
  rows: ExportCell[][]
  // True when row 0 of the sheet was not usable as a header and we
  // generated col1..colN instead. Surfaces in a post-export toast.
  usedGeneratedHeader: boolean
}

type UniverInstance = ReturnType<typeof createUniver>
type UniverAPI = UniverInstance['univerAPI']
type ActiveWorkbook = NonNullable<ReturnType<UniverAPI['getActiveWorkbook']>>
type ActiveSheet = ReturnType<ActiveWorkbook['getActiveSheet']>

// --- File helpers -----------------------------------------------------------

// Windows reserved device names — these are illegal as file stems (with
// or without an extension) on NTFS. Collision with them produces
// hard-to-debug "access denied" errors on download. Prefix with `_` to
// sidestep.
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i

export function sanitizeFilename(name: string, fallback = 'sheet'): string {
  let cleaned = name.replace(/[\/\\?%*:|"<>\x00-\x1f]/g, '_').trim().slice(0, 100)
  if (!cleaned) return fallback
  if (WINDOWS_RESERVED.test(cleaned)) cleaned = '_' + cleaned
  return cleaned
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Defer revocation: some browsers start the download asynchronously and
  // revoking synchronously can abort it. 60 s is well past any user-
  // visible download dialog; memory is reclaimed on tab close regardless.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// Prefix cells that could be interpreted as formulas with a single quote so
// they're treated as text by Excel/Sheets/LibreOffice instead of formulas.
// Defends recipients of exported files against CSV/XLSX injection (OWASP).
// \s* catches space-then-formula (Excel/Sheets trim leading whitespace before
// evaluating). \t and \r stay in a separate branch — they're injection triggers
// regardless of what follows.
export function csvSafe(cell: ExportCell): ExportCell {
  if (typeof cell !== 'string') return cell
  return /^\s*[=+\-@]/.test(cell) || /^[\t\r]/.test(cell) ? `'${cell}` : cell
}

// --- Sheet extraction -------------------------------------------------------

export function sheetToRowsRaw(sheet: ActiveSheet): ExportCell[][] {
  const lastRow = sheet.getLastRow()
  const lastCol = sheet.getLastColumn()
  if (lastRow < 0 || lastCol < 0) return []
  const range = sheet.getRange(0, 0, lastRow + 1, lastCol + 1)
  return range.getValues().map((row) =>
    row.map((c): ExportCell => (c === null || c === undefined ? null : (c as ExportCell))),
  )
}

export function sheetToRowsCsvSafe(sheet: ActiveSheet): ExportCell[][] {
  return sheetToRowsRaw(sheet).map((row) => row.map(csvSafe))
}

// --- Identifier sanitization -----------------------------------------------

// Returns a SQL identifier whose body matches [A-Za-z_][A-Za-z0-9_]*.
// Output is still always emitted inside "..." (with " → "" escape) by the
// caller, so reserved words stay safe.
export function sanitizeSqlIdent(raw: string, fallback: string): string {
  const nfkd = raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip combining marks
  let s = nfkd.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  if (s === '') s = fallback
  if (/^\d/.test(s)) s = '_' + s
  if (s.length > 63) s = s.slice(0, 63)
  return s
}

// Escape a sanitized identifier for embedding inside "..." (defensive — after
// sanitization there should be no embedded double quotes, but the caller
// pattern of "always quote, always escape" stays intact).
export function quoteIdent(ident: string): string {
  return '"' + ident.replace(/"/g, '""') + '"'
}

export function dedupeIdents(names: string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((name) => {
    const count = (seen.get(name) ?? 0) + 1
    seen.set(name, count)
    return count === 1 ? name : `${name}_${count}`
  })
}

// --- Header detection ------------------------------------------------------

// Row 0 is a header only if every cell is a non-empty string whose first
// non-space character is not a digit or +/-. Numeric cells, empty cells, or
// JS booleans in row 0 all disqualify it.
export function isHeaderRow(row: ExportCell[] | undefined): boolean {
  if (!row || row.length === 0) return false
  for (const c of row) {
    if (typeof c !== 'string') return false
    const t = c.trim()
    if (t === '') return false
    if (/^[+\-\d]/.test(t)) return false
  }
  return true
}

// --- Column type inference -------------------------------------------------

type CellKind = 'integer' | 'real' | 'text' | 'null'

function classifyCell(cell: ExportCell): CellKind {
  if (cell === null || cell === '') return 'null'
  if (typeof cell === 'number') {
    if (!Number.isFinite(cell)) return 'text'
    return Number.isInteger(cell) ? 'integer' : 'real'
  }
  if (typeof cell === 'boolean') return 'text'
  const s = cell.trim()
  if (s === '') return 'null'
  // Leading-zero strings (except "0" and "0.x") are identifiers — preserve.
  if (/^[+-]?0\d/.test(s)) return 'text'
  // Thousands separator — ambiguous (US vs EU) and not a SQL number literal.
  if (s.includes(',')) return 'text'
  if (/^[+-]?\d+$/.test(s)) {
    // Precision guard: JS number is safe up to 15 digits (MAX_SAFE_INTEGER
    // has 16 but not every 16-digit value fits). Longer integers stay TEXT
    // to preserve exact digits through round-trip.
    const digits = s.replace(/^[+-]/, '').length
    return digits <= 15 ? 'integer' : 'text'
  }
  if (/^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(s)) return 'real'
  return 'text'
}

export function inferColumnType(cells: ExportCell[]): ColumnType {
  let sawInteger = false
  let sawReal = false
  for (const c of cells) {
    const kind = classifyCell(c)
    if (kind === 'null') continue
    if (kind === 'text') return 'TEXT'
    if (kind === 'real') sawReal = true
    if (kind === 'integer') sawInteger = true
  }
  if (sawReal) return 'REAL'
  if (sawInteger) return 'INTEGER'
  return 'TEXT'
}

// Coerce a cell to the storage form for its column type. Nullish / empty
// always → null. TEXT columns stringify numbers/booleans.
export function coerceForColumn(cell: ExportCell, type: ColumnType): ExportCell {
  if (cell === null || cell === '') return null
  if (type === 'INTEGER' || type === 'REAL') {
    if (typeof cell === 'number') {
      if (!Number.isFinite(cell)) return null
      return cell
    }
    if (typeof cell === 'boolean') return null
    const n = Number((cell as string).trim())
    return Number.isFinite(n) ? n : null
  }
  // TEXT
  if (typeof cell === 'string') return cell
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE'
  return String(cell)
}

// --- TableSpec assembly ----------------------------------------------------

export type SheetData = { name: string; rows: ExportCell[][] }

export function buildTableSpec(sheet: SheetData, usedTableNames: Set<string>): TableSpec | null {
  const rows = sheet.rows
  // `rows.every(r => r.every(...))` also matches rows of length 0, so any
  // all-empty case (including zero-width rows) short-circuits to null here.
  if (rows.length === 0 || rows.every((r) => r.every((c) => c === null || c === ''))) return null

  const width = rows.reduce((m, r) => Math.max(m, r.length), 0)

  const tableName = uniqueify(sanitizeSqlIdent(sheet.name, 'sheet'), usedTableNames)
  usedTableNames.add(tableName)

  const headerRow = rows[0]
  const hasHeader = isHeaderRow(headerRow) && headerRow.length === width
  const dataRows = hasHeader ? rows.slice(1) : rows

  // Normalize row widths (pad short rows with null).
  const normalizedRows: ExportCell[][] = dataRows.map((r) => {
    if (r.length === width) return r.slice()
    const padded = r.slice()
    while (padded.length < width) padded.push(null)
    return padded
  })

  // Column names
  const rawNames = hasHeader
    ? (headerRow as string[]).map((s, i) => sanitizeSqlIdent(s, `col${i + 1}`))
    : Array.from({ length: width }, (_, i) => `col${i + 1}`)
  const columnNames = dedupeIdents(rawNames)

  // Infer types per column
  const columns: ColumnSpec[] = columnNames.map((name, i) => {
    const colCells = normalizedRows.map((r) => r[i] ?? null)
    return { name, type: inferColumnType(colCells) }
  })

  // Coerce every cell to its column type
  const coercedRows: ExportCell[][] = normalizedRows.map((r) =>
    r.map((cell, i) => coerceForColumn(cell, columns[i].type)),
  )

  return {
    tableName,
    columns,
    rows: coercedRows,
    usedGeneratedHeader: !hasHeader,
  }
}

function uniqueify(name: string, used: Set<string>): string {
  if (!used.has(name)) return name
  let i = 2
  while (used.has(`${name}_${i}`)) i += 1
  return `${name}_${i}`
}

// --- Active-workbook iterator (for exporters that need all sheets) ---------

export function collectTableSpecs(
  wb: ActiveWorkbook,
  transform: (sheet: ActiveSheet) => ExportCell[][] = sheetToRowsRaw,
): TableSpec[] {
  const sheets = wb.getSheets()
  const used = new Set<string>()
  const out: TableSpec[] = []
  for (const sheet of sheets) {
    const data: SheetData = {
      name: sheet.getSheetName() || 'Sheet',
      rows: transform(sheet),
    }
    const spec = buildTableSpec(data, used)
    if (spec) out.push(spec)
  }
  return out
}

// --- String-literal escape used by the SQL text exporter -------------------

// SQLite / ANSI string literal: wrap in single quotes, double any embedded
// single quote. NUL bytes are stripped upstream (they trip some SQL clients).
export function sqlStringLiteral(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'"
}
