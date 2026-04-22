import { expect, test } from '@playwright/test'
import {
  downloadText,
  dropFile,
  exportVia,
  readCell,
  waitForWorkbookReady,
  writeCell,
} from './helpers'

// Univer evaluates formulas client-side. We need to verify (a) the cell
// displays the computed value after edit, and (b) CSV export materialises
// the computed value, not the formula text (Sheets/Excel do the same).

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await dropFile(page, 'sample.csv', 'text/csv')
  await waitForWorkbookReady(page)
})

test('SUM formula evaluates and exports as the computed number', async ({ page }) => {
  // Total qty (col C, rows 2-5): 3 + 5 + 2 + 1 = 11.
  await writeCell(page, 'Sheet1', 'C6', '=SUM(C2:C5)')
  // Univer computes formulas asynchronously; poll until the value lands.
  await expect.poll(async () => await readCell(page, 'Sheet1', 'C6'), {
    timeout: 10_000,
  }).toBe(11)

  const dl = await exportVia(page, 'CSV')
  const text = await downloadText(dl)
  const lastLine = text.trim().split(/\r?\n/).pop()!
  // The computed value must be the materialised number 11 — not the
  // literal "=SUM(C2:C5)" which Excel/Sheets would treat as an unsafe
  // formula on re-import.
  expect(lastLine.split(',')).toContain('11')
  expect(text).not.toContain('=SUM(C2:C5)')
})

test('multiplication formula materialises to a REAL value in the export', async ({ page }) => {
  // qty * price for Apple: 3 * 0.5 = 1.5.
  await writeCell(page, 'Sheet1', 'E2', '=C2*D2')
  await expect.poll(async () => await readCell(page, 'Sheet1', 'E2'), {
    timeout: 10_000,
  }).toBe(1.5)
  const dl = await exportVia(page, 'CSV')
  const text = await downloadText(dl)
  expect(text).toContain('1.5')
})
