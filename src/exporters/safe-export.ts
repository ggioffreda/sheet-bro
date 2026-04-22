import { BlobWriter, Uint8ArrayReader, ZipWriter } from '@zip.js/zip.js'
import type { createUniver } from '@univerjs/presets'
import { buildCsvExport } from './csv'
import { buildXlsxExport } from './xlsx'
import { buildSqlExport, type SqlExportResult } from './sql'
import { buildSqliteExport, type SqliteExportResult } from './sqlite'
import { downloadBlob } from './shared'

type UniverAPI = ReturnType<typeof createUniver>['univerAPI']

async function encryptedZip(innerFilename: string, bytes: Uint8Array, password: string): Promise<Blob> {
  const writer = new ZipWriter(new BlobWriter('application/zip'), { password, encryptionStrength: 3 })
  await writer.add(innerFilename, new Uint8ArrayReader(bytes))
  return writer.close()
}

export async function safeExportCsv(api: UniverAPI, password: string, stem?: string): Promise<null> {
  const result = await buildCsvExport(api, stem)
  if (!result) return null
  const blob = await encryptedZip(result.filename, result.bytes, password)
  downloadBlob(blob, `${result.filename}.zip`)
  return null
}

export async function safeExportXlsx(api: UniverAPI, password: string, stem?: string): Promise<null> {
  const result = await buildXlsxExport(api, stem)
  if (!result) return null
  const blob = await encryptedZip(result.filename, result.bytes, password)
  downloadBlob(blob, `${result.filename}.zip`)
  return null
}

export async function safeExportSql(api: UniverAPI, password: string, stem?: string): Promise<SqlExportResult> {
  const result = buildSqlExport(api, stem)
  if (!result) return { tableCount: 0, generatedHeaderCount: 0 }
  const blob = await encryptedZip(result.filename, result.bytes, password)
  downloadBlob(blob, `${result.filename}.zip`)
  return result.meta
}

export async function safeExportSqlite(api: UniverAPI, password: string, stem?: string): Promise<SqliteExportResult> {
  const result = await buildSqliteExport(api, stem)
  if (!result) return { tableCount: 0, generatedHeaderCount: 0 }
  const blob = await encryptedZip(result.filename, result.bytes, password)
  downloadBlob(blob, `${result.filename}.zip`)
  return result.meta
}
