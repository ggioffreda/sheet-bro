import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { expect, test } from '@playwright/test'
import {
  downloadBytes,
  dropFile,
  exportVia,
  listSheets,
  waitForWorkbookReady,
} from './helpers'

// A 2-table SQLite file must survive drop → Univer → export → re-parse
// with identical table names and row counts. This catches regressions
// in multi-sheet snapshot shape (sheetOrder) and the exporter's per-sheet
// table naming.

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

test('SQLite 2-table input round-trips back to a 2-table SQLite export', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await dropFile(page, 'sample.sqlite', 'application/vnd.sqlite3')
  await waitForWorkbookReady(page)

  // Workbook side: two sheets, sorted by name (importers/sql.ts sorts).
  expect(await listSheets(page)).toEqual(['items', 'tags'])

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
