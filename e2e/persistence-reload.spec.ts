import { expect, test } from '@playwright/test'
import { dropFile, readCell, waitForWorkbookReady, writeCell } from './helpers'

// The persistence contract: every edit survives a page reload (same
// browser context = same sessionStorage tab id), but a fresh context
// sees no leaked data (per-tab isolation via the AES key in
// sessionStorage + tab UUID).

test('an edit survives a page reload in the same tab', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })

  await dropFile(page, 'sample.csv', 'text/csv')
  await waitForWorkbookReady(page)
  expect(await readCell(page, 'Sheet1', 'B2')).toBe('Apple')

  await writeCell(page, 'Sheet1', 'B2', 'Edited Apple')
  expect(await readCell(page, 'Sheet1', 'B2')).toBe('Edited Apple')

  // Reload — the same browser context retains sessionStorage.
  await page.reload()
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  // The workbook must restore WITHOUT the empty-state overlay showing —
  // if it's still visible the snapshot wasn't loaded.
  await expect(page.locator('#empty-state')).toBeHidden({ timeout: 10_000 })
  expect(await readCell(page, 'Sheet1', 'B2')).toBe('Edited Apple')
})

test('a fresh browser context does not see another tab\'s workbook', async ({ browser }) => {
  // Tab A: drop a CSV and persist.
  const ctxA = await browser.newContext()
  const pageA = await ctxA.newPage()
  await pageA.goto('/')
  await expect(pageA.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await dropFile(pageA, 'sample.csv', 'text/csv')
  await waitForWorkbookReady(pageA)
  await writeCell(pageA, 'Sheet1', 'B2', 'Tab A Edit')

  // Tab B: fresh context → fresh sessionStorage → fresh tab id → no snapshot.
  const ctxB = await browser.newContext()
  const pageB = await ctxB.newPage()
  await pageB.goto('/')
  await expect(pageB.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  // An empty workbook must still be shown, and the empty-state overlay
  // must be visible — there's no saved snapshot to restore.
  await expect(pageB.locator('#empty-state')).toBeVisible()

  await ctxA.close()
  await ctxB.close()
})
