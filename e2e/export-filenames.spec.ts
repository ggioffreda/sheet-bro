import { expect, test } from '@playwright/test'
import { dropFile, exportVia, expectNotify, waitForWorkbookReady } from './helpers'

// The download filename stem must follow the current tab name (Sheet-NNNN on
// cold start; fileBasedTabName after a drop). Also verifies the two notify
// surfaces that exports emit: "Nothing to export" and the "N tables with
// generated column names" summary.

test.describe('filename stems', () => {
  // One test per format — repeated exportVia calls on the same page can leave
  // Univer's ribbon in a mid-transition state (File tab stays selected,
  // dropdown fails to re-open). Fresh goto per format keeps the interaction
  // deterministic without adding reset logic to the helper.
  for (const [format, ext] of [
    ['CSV', 'csv'], ['Xlsx', 'xlsx'], ['SQL', 'sql'], ['SQLite', 'sqlite'],
  ] as const) {
    test(`file-based stem after dropping sample.csv (${format})`, async ({ page }) => {
      await page.goto('/')
      await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
      await dropFile(page, 'sample.csv', 'text/csv')
      await waitForWorkbookReady(page)
      const dl = await exportVia(page, format)
      expect(dl.suggestedFilename()).toMatch(new RegExp(`^Sample-\\d{2}-[A-Z][a-z]{2}-\\d{2}-\\d{2}\\.${ext}$`))
    })
  }

  test('default Sheet-NNNN stem before any drop (CSV)', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
    // Wait for initTabName to finish (document.title reflects Sheet-NNNN).
    await expect.poll(async () => await page.title(), { timeout: 5_000 }).toMatch(/^Sheet-\d{4} —/)
    const dl = await exportVia(page, 'CSV')
    expect(dl.suggestedFilename()).toMatch(/^Sheet-\d{4}\.csv$/)
  })
})

test.describe('generated-column-names toast', () => {
  test('SQL export of a headerless sheet surfaces a summary toast', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
    // Build a workbook whose row 0 is numeric so isHeaderRow() returns false
    // and columns fall back to col1..colN.
    await page.evaluate(() => {
      type Wb = {
        getSheets: () => Array<{ getSheetName: () => string; getRange: (a1: string) => { setValue: (v: unknown) => void } }>
      }
      const api = (window as unknown as { __sheetbro: { univerAPI: { getActiveWorkbook: () => Wb | null } } }).__sheetbro.univerAPI
      const wb = api.getActiveWorkbook()!
      const ws = wb.getSheets()[0]
      // Use Univer's range API to stamp numeric values in a 2×2 block.
      ws.getRange('A1').setValue(1)
      ws.getRange('B1').setValue(2)
      ws.getRange('A2').setValue(3)
      ws.getRange('B2').setValue(4)
    })
    const dl = await exportVia(page, 'SQL')
    await dl.path() // drain the download so the action completes
    await expectNotify(page, /\d+ tables? with generated column names/i, 10_000)
  })
})
