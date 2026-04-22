import { expect, test } from '@playwright/test'
import { dropFile, expectNotify } from './helpers'

// Covers the IMPORT_TIMEOUT_MS guard at src/app.ts:641-647. Loading the
// page with `?importTimeoutMs=200` (only honoured under VITE_E2E)
// shrinks the 30 s wall to 200 ms so we can drive the timeout without a
// genuinely huge fixture. Then we monkey-patch FileReader.readAsText to
// hang so the CSV read never resolves — the timeoutPromise must win the
// race and the toast must surface.

test('surfaces a timeout toast when import runs past IMPORT_TIMEOUT_MS', async ({ page }) => {
  await page.goto('/?importTimeoutMs=300')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })

  // Make FileReader.readAsText hang — that freezes the CSV phase-1 read,
  // which is the first await inside loadIntoWorkbook for csv files.
  await page.evaluate(() => {
    const proto = FileReader.prototype as unknown as { readAsText: (...args: unknown[]) => void }
    proto.readAsText = () => { /* never fires onload / onerror */ }
  })

  await dropFile(page, 'sample.csv', 'text/csv')

  // The thrown Error from the timeoutPromise is caught in app.ts and routed
  // to a sticky notify. Match either the timeout message or a generic
  // import-failure fallback.
  await expectNotify(page, /timed out|import failed|could not/i, 10_000)
})
