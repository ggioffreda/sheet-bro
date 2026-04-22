import { expect, test } from '@playwright/test'
import { dropFile } from './helpers'

// The app's UI state is driven entirely by DOM attributes — no framework.
// These transitions are therefore only visible end-to-end, not via unit
// tests. Regressions here typically manifest as "the logo is covered" or
// "the empty-state overlay never goes away after a drop".

test('cold-start shows #empty-state and applies .is-ready after Univer mounts', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('#empty-state')).toBeVisible()
})

test('dragenter shows #drag-overlay; drop hides it again and hides #empty-state', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })

  // Fire dragenter without dropping — overlay should appear.
  await page.evaluate(() => {
    const target = document.getElementById('csv-spreadsheet')!
    const dt = new DataTransfer()
    target.dispatchEvent(
      new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }),
    )
  })
  await expect(page.locator('#drag-overlay')).toBeVisible()

  // Actually dropping a file must hide both overlays.
  await dropFile(page, 'sample.csv', 'text/csv')
  await expect(page.locator('#drag-overlay')).toBeHidden({ timeout: 5_000 })
  await expect(page.locator('#empty-state')).toBeHidden({ timeout: 10_000 })
})
