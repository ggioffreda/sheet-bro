import { expect, test } from '@playwright/test'
import {
  dropFile,
  listSheets,
  readCell,
  waitForWorkbookReady,
} from './helpers'

// Each dropped format must materialise as a workbook with the expected
// sheet name(s) and a recognisable cell value. If any branch of the file-
// router dispatch regresses, these tests catch it end-to-end.

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
})

test('CSV drop loads a single sheet named "Sheet1" with the expected cells', async ({ page }) => {
  await dropFile(page, 'sample.csv', 'text/csv')
  await waitForWorkbookReady(page)
  await expect.poll(async () => await listSheets(page)).toEqual(['Sheet1'])
  expect(await readCell(page, 'Sheet1', 'A1')).toBe('id')
  expect(await readCell(page, 'Sheet1', 'B2')).toBe('Apple')
  expect(await readCell(page, 'Sheet1', 'C3')).toBe(5)
})

test('XLSX drop loads the sheet with its original name', async ({ page }) => {
  await dropFile(
    page,
    'sample.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  await waitForWorkbookReady(page)
  await expect.poll(async () => await listSheets(page)).toEqual(['Items'])
  expect(await readCell(page, 'Items', 'B2')).toBe('Apple')
})

test('SQLite drop loads one sheet per user table, sorted by name', async ({ page }) => {
  await dropFile(page, 'sample.sqlite', 'application/vnd.sqlite3')
  await waitForWorkbookReady(page)
  // importSql prepends column names as row 0 and orders tables by name.
  await expect.poll(async () => await listSheets(page)).toEqual(['items', 'tags'])
  expect(await readCell(page, 'items', 'A1')).toBe('id')
  expect(await readCell(page, 'items', 'B2')).toBe('Apple')
  expect(await readCell(page, 'tags', 'A1')).toBe('item_id')
  expect(await readCell(page, 'tags', 'B2')).toBe('fruit')
})

test('SQL dump drop loads one sheet per table declared in the dump', async ({ page }) => {
  await dropFile(page, 'sample.sql', 'application/sql')
  await waitForWorkbookReady(page)
  await expect.poll(async () => await listSheets(page)).toEqual(['items', 'tags'])
  expect(await readCell(page, 'items', 'B2')).toBe('Apple')
})
