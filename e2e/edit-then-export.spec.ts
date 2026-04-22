import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import initSqlJs, { type SqlJsStatic } from 'sql.js'
import { expect, test } from '@playwright/test'
import {
  downloadBytes,
  downloadText,
  dropFile,
  exportVia,
  waitForWorkbookReady,
  writeCell,
} from './helpers'

// A cell edit must be reflected in the next export — the failure mode
// would be reading from a stale pre-edit snapshot. Exercise with CSV
// and SQLite targets so both the text and binary pipelines are covered.

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
  await dropFile(page, 'sample.csv', 'text/csv')
  await waitForWorkbookReady(page)
})

test('edited cell value appears in the CSV export', async ({ page }) => {
  await writeCell(page, 'Sheet1', 'B2', 'EditedApple')
  const dl = await exportVia(page, 'CSV')
  const text = await downloadText(dl)
  // The edited row must have the new cell value; there must be no row
  // with the original "Apple" name anywhere in the output.
  expect(text).toContain('1,EditedApple,3,0.5')
  expect(text.split(/\r?\n/)).not.toContain('1,Apple,3,0.5')
})

test('edited cell value appears in the SQLite export', async ({ page }) => {
  await writeCell(page, 'Sheet1', 'B2', 'EditedApple')
  const dl = await exportVia(page, 'SQLite')
  const bytes = await downloadBytes(dl)
  const db = new SQL.Database(new Uint8Array(bytes))
  try {
    const res = db.exec('SELECT name FROM "Sheet1" WHERE id = 1')
    expect(res[0].values[0][0]).toBe('EditedApple')
  } finally {
    db.close()
  }
})

test('a new value typed into an empty cell shows up on round-trip', async ({ page }) => {
  await writeCell(page, 'Sheet1', 'E1', 'extra_col')
  await writeCell(page, 'Sheet1', 'E2', 'note-1')
  const dl = await exportVia(page, 'CSV')
  const text = await downloadText(dl)
  expect(text).toContain('extra_col')
  expect(text).toContain('note-1')
})
