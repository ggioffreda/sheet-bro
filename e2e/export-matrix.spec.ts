import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import Papa from 'papaparse'
import readXlsxFile from 'read-excel-file/node'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { expect, test } from '@playwright/test'
import { downloadBytes, downloadText, dropFile, exportVia, waitForWorkbookReady } from './helpers'

// Round-trip matrix: drop each input format, export it in every output
// format, and re-parse the bytes. Each assertion proves the full pipeline
// (importer → Univer → exporter → downloadBlob → bytes) survives.

let SQL: SqlJsStatic
test.beforeAll(async () => {
  const nodeRequire = createRequire(import.meta.url)
  const wasmBuffer = readFileSync(nodeRequire.resolve('sql.js/dist/sql-wasm.wasm'))
  SQL = await initSqlJs({
    wasmBinary: wasmBuffer.buffer.slice(
      wasmBuffer.byteOffset,
      wasmBuffer.byteOffset + wasmBuffer.byteLength,
    ),
  })
})

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
})

const CSV_MIME = 'text/csv'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

async function dropCsvSample(page: import('@playwright/test').Page) {
  await dropFile(page, 'sample.csv', CSV_MIME)
  await waitForWorkbookReady(page)
}

test('CSV → CSV round-trip preserves every data row', async ({ page }) => {
  await dropCsvSample(page)
  const dl = await exportVia(page, 'CSV')
  const text = await downloadText(dl)
  const rows = Papa.parse<string[]>(text.trim(), { skipEmptyLines: true }).data
  expect(rows[0]).toEqual(['id', 'name', 'qty', 'price'])
  expect(rows[1]).toEqual(['1', 'Apple', '3', '0.5'])
  expect(rows[4]).toEqual(['4', 'Mango', '1', '1.25'])
})

test('CSV → XLSX round-trip preserves header + first data row', async ({ page }) => {
  await dropCsvSample(page)
  const dl = await exportVia(page, 'Xlsx')
  const bytes = await downloadBytes(dl)
  const rows = await readSingleSheetRows(bytes)
  expect(rows[0]).toEqual(['id', 'name', 'qty', 'price'])
  expect(rows[1][1]).toBe('Apple')
})

test('CSV → SQL round-trip loads into sql.js with typed columns', async ({ page }) => {
  await dropCsvSample(page)
  const dl = await exportVia(page, 'SQL')
  const text = await downloadText(dl)
  const db = new SQL.Database()
  try {
    db.exec(text)
    const res = db.exec('SELECT id, name, qty, price FROM "Sheet1" ORDER BY id')
    expect(res[0].values).toEqual([
      [1, 'Apple', 3, 0.5],
      [2, 'Pear', 5, 0.75],
      [3, 'Banana', 2, 0.3],
      [4, 'Mango', 1, 1.25],
    ])
  } finally {
    db.close()
  }
})

test('CSV → SQLite round-trip produces a valid .sqlite file with the same rows', async ({ page }) => {
  await dropCsvSample(page)
  const dl = await exportVia(page, 'SQLite')
  const bytes = await downloadBytes(dl)
  expect(bytes.slice(0, 15).toString('utf8')).toBe('SQLite format 3')
  const db = new SQL.Database(new Uint8Array(bytes))
  try {
    const res = db.exec('SELECT COUNT(*) FROM "Sheet1"')
    expect(res[0].values[0][0]).toBe(4)
  } finally {
    db.close()
  }
})

test('SQLite → SQLite round-trip preserves both tables and row counts', async ({ page }) => {
  await dropFile(page, 'sample.sqlite', 'application/vnd.sqlite3')
  await waitForWorkbookReady(page)
  const dl = await exportVia(page, 'SQLite')
  const bytes = await downloadBytes(dl)
  const db = new SQL.Database(new Uint8Array(bytes))
  try {
    const tables = db
      .exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")[0]
      .values.map((r) => r[0] as string)
    expect(tables).toEqual(['items', 'tags'])
    expect(db.exec('SELECT COUNT(*) FROM "items"')[0].values[0][0]).toBe(4)
    expect(db.exec('SELECT COUNT(*) FROM "tags"')[0].values[0][0]).toBe(4)
  } finally {
    db.close()
  }
})

test('XLSX → XLSX round-trip preserves the sheet name and the first data row', async ({ page }) => {
  await dropFile(page, 'sample.xlsx', XLSX_MIME)
  await waitForWorkbookReady(page)
  const dl = await exportVia(page, 'Xlsx')
  const bytes = await downloadBytes(dl)
  const rows = await readSingleSheetRows(bytes)
  expect(rows[0][0]).toBe('id')
  expect(rows[1][1]).toBe('Apple')
})

// read-excel-file's node entry point (read from Buffer) returns an array
// of `{ sheet, data }` objects — one per sheet. Extract the first sheet's
// rows for the single-sheet specs.
async function readSingleSheetRows(bytes: Buffer): Promise<unknown[][]> {
  const result = (await readXlsxFile(bytes)) as unknown as Array<{ sheet: string; data: unknown[][] }>
  return result[0].data
}
