import {
  importCsv,
  importSql,
  importXlsx,
  isSqlDumpFile,
  isSqliteFile,
  isXlsxFile,
  type LoadedSheet,
} from './importers'

export type Importer = (file: File) => Promise<LoadedSheet[]>

export type FileKind = 'xlsx' | 'sqlite' | 'sql' | 'csv'

// Magic byte prefixes — the only reliable way to tell a renamed file from
// a real one. XLSX is a ZIP envelope; SQLite carries a fixed 16-byte
// header. SQL dumps have no deterministic magic, so they stay
// extension-routed.
const XLSX_MAGIC = [0x50, 0x4b, 0x03, 0x04] // "PK\x03\x04"
const SQLITE_MAGIC = [
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66,
  0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
] // "SQLite format 3\0"

async function readHead(file: File, n: number): Promise<Uint8Array> {
  const slice = file.slice(0, Math.min(n, file.size))
  return new Uint8Array(await slice.arrayBuffer())
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false
  }
  return true
}

// Determine the file kind by sniffing magic bytes, falling back to the
// existing extension/MIME heuristics when the sniff is inconclusive (empty
// file, or format with no magic). The fallback order matters — XLSX wins
// over SQL because the regression guard in the old test suite required it.
export async function detectFileKind(file: File): Promise<FileKind> {
  const head = await readHead(file, 16)
  if (startsWith(head, XLSX_MAGIC)) return 'xlsx'
  if (startsWith(head, SQLITE_MAGIC)) return 'sqlite'
  if (isXlsxFile(file)) return 'xlsx'
  if (isSqliteFile(file)) return 'sqlite'
  if (isSqlDumpFile(file)) return 'sql'
  return 'csv'
}

export function importerForKind(kind: FileKind): Importer {
  switch (kind) {
    case 'xlsx': return importXlsx
    case 'sqlite': return importSql
    case 'sql': return importSql
    case 'csv': return importCsv
  }
}

export function labelForKind(kind: FileKind): string {
  switch (kind) {
    case 'xlsx': return 'XLSX file'
    case 'sqlite': return 'SQLite database'
    case 'sql': return 'SQL dump'
    case 'csv': return 'CSV file'
  }
}
