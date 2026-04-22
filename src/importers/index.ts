export type CellPrimitive = string | number | boolean | Date | Uint8Array | null
export type LoadedSheet = { name: string; rows: CellPrimitive[][] }

export { importCsv, parseCsvText } from './csv'
export { importXlsx, isXlsxFile } from './xlsx'
export { importSql, parseSqlDump, parseSqliteBytes, isSqliteFile, isSqlDumpFile } from './sql'
