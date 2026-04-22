import { expect, test } from '@playwright/test'
import {
  downloadText,
  dropFile,
  exportVia,
  listSheets,
  readCell,
  waitForWorkbookReady,
} from './helpers'

// Compensating coverage for the xlsx unit tests, which mock
// read-excel-file (it can't run under happy-dom). Here we drop a real
// xlsx built by the globalSetup fixture builder — with a Date cell in
// the data — then check that:
//   1. Univer imports the file without error.
//   2. The header row and typed data land in the expected cells.
//   3. The Date cell round-trips to an ISO-8601 string on CSV export
//      (matches src/cell.ts normalizeCell contract — the coercion rule
//      that has no direct unit coverage because read-excel-file is mocked).

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await dropFile(
    page,
    'features.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  await waitForWorkbookReady(page)
})

test('imports a feature xlsx and round-trips Date cells to ISO strings on CSV export', async ({ page }) => {
  const sheets = await listSheets(page)
  expect(sheets).toContain('Features')

  // Header + data row shape.
  const headerA = await readCell(page, 'Features', 'A1')
  const dataRegion = await readCell(page, 'Features', 'A2')
  const dataRevenue = await readCell(page, 'Features', 'B2')
  expect(headerA).toBe('region')
  expect(dataRegion).toBe('North')
  expect(dataRevenue).toBe(1000)

  // CSV export should materialise the Date as ISO-8601 per normalizeCell's
  // Date → `d.toISOString()` rule. Fixture date is 2026-01-15T09:30:00Z.
  const dl = await exportVia(page, 'CSV')
  const text = await downloadText(dl)
  expect(text).toMatch(/2026-01-15/)
})
