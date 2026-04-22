import { expect, test } from '@playwright/test'
import { dropFile, expectNotify, waitForWorkbookReady, writeCell } from './helpers'

// Covers the quota-exceeded catch in src/app.ts:579-585. When the
// IndexedDB `put` throws a QuotaExceededError the app must surface a
// sticky toast so the user knows their edits won't persist, and it
// must not crash subsequent edits.

test('surfaces a sticky notify when saveSnapshot hits a quota error', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await dropFile(page, 'sample.csv', 'text/csv')
  await waitForWorkbookReady(page)

  // Monkey-patch IDBObjectStore.prototype.put so the workbook store
  // rejects with a DOMException[QuotaExceededError]. Scope the stub to
  // the 'workbooks' object store to avoid poisoning the tab-metadata
  // writes (which would otherwise fire the same error on unrelated
  // side-writes and make the toast observable for the wrong reason).
  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ): IDBRequest {
      if (this.name === 'workbooks') {
        throw new DOMException('simulated quota', 'QuotaExceededError')
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return originalPut.call(this, value as any, key as any)
    }
  })

  // Edit a cell — this drives writeCell → persistNow → saveSnapshot → put.
  await writeCell(page, 'Sheet1', 'F1', 'x')

  await expectNotify(page, /too large to save|will not persist/i, 10_000)
})
