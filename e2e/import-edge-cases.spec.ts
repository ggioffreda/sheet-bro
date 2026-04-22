import { expect, test } from '@playwright/test'
import { dropFile, expectNotify, waitForWorkbookReady } from './helpers'

// Import-path edge cases that unit tests cannot cover: progress-bar lifecycle,
// multi-file drop handling, 50 MB pre-decompression cap, empty CSV behavior.

test('progress bar appears during a CSV import and hides after', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  // Watch the #progress-bar hidden-attribute transitions — it flips false
  // during showProgress() and back to true ~300 ms after completeProgress().
  await page.evaluate(() => {
    const el = document.getElementById('progress-bar')!
    ;(window as unknown as { __progress: string[] }).__progress = []
    new MutationObserver(() => {
      (window as unknown as { __progress: string[] }).__progress.push(
        el.hasAttribute('hidden') ? 'hidden' : 'visible',
      )
    }).observe(el, { attributes: true, attributeFilter: ['hidden'] })
  })
  await dropFile(page, 'sample.csv', 'text/csv')
  await waitForWorkbookReady(page)
  // Allow the 300 ms post-complete hide to settle.
  await page.waitForTimeout(600)
  const states = await page.evaluate(() => (window as unknown as { __progress: string[] }).__progress)
  // Must have been visible at least once, and end hidden.
  expect(states).toContain('visible')
  expect(states[states.length - 1]).toBe('hidden')
})

test('dropping multiple files shows a warning and loads only the first', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  // Build two Files in the page context and dispatch a drop carrying both.
  await page.evaluate(() => {
    const mkFile = (name: string, content: string) =>
      new File([content], name, { type: 'text/csv' })
    const dt = new DataTransfer()
    dt.items.add(mkFile('first.csv', 'a,b\n1,2\n'))
    dt.items.add(mkFile('second.csv', 'x,y\n9,8\n'))
    const target = document.getElementById('csv-spreadsheet')!
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
    }
  })
  await expectNotify(page, /drop one file at a time/i)
  await waitForWorkbookReady(page)
  // Title stem is derived from the first file's name.
  await expect.poll(async () => await page.title(), { timeout: 5_000 }).toMatch(/^First-/)
})

test('dropping a file larger than the 50 MB cap is rejected with a sticky toast', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await page.evaluate(() => {
    // 51 MB buffer — over the MAX_FILE_BYTES (50 MB) cap in src/app.ts.
    const bytes = new Uint8Array(51 * 1024 * 1024)
    const file = new File([bytes], 'huge.csv', { type: 'text/csv' })
    const dt = new DataTransfer()
    dt.items.add(file)
    const target = document.getElementById('csv-spreadsheet')!
    for (const type of ['dragenter', 'dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
    }
  })
  await expectNotify(page, /file too large/i, 10_000)
  // Workbook must still be the empty default — the default-name tab title
  // stays present and the empty-state overlay is visible.
  await expect(page.locator('#empty-state')).toBeVisible()
})

test('dropping an empty CSV does not crash the app', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await dropFile(page, 'empty.csv', 'text/csv')
  // The app may notify or silently fall back; either way no pageerror should fire.
  await page.waitForTimeout(1500)
  expect(errors).toEqual([])
})
