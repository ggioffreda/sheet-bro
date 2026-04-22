import Papa from 'papaparse'
import { expect, test } from '@playwright/test'
import {
  dropFile,
  downloadBytes,
  isZipBytes,
  openSafeExportDialog,
  safeExportVia,
  unzipFirst,
  waitForWorkbookReady,
} from './helpers'

const PASSWORD = 'pw-0123-test'

// These specs each drop sample.csv before exercising the Safe Export flow, so
// the tab stem resolves to `Sample-…` and the inner filename reflects that.

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await dropFile(page, 'sample.csv', 'text/csv')
  await waitForWorkbookReady(page)
})

for (const [format, innerExt] of [
  ['CSV', 'csv'], ['Xlsx', 'xlsx'], ['SQL', 'sql'], ['SQLite', 'sqlite'],
] as const) {
  test(`Safe Export → ${format} downloads a password-protected ZIP`, async ({ page }) => {
    const dl = await safeExportVia(page, format, PASSWORD)
    const name = dl.suggestedFilename()
    expect(name).toMatch(new RegExp(`^Sample-.+\\.${innerExt}\\.zip$`))
    const bytes = await downloadBytes(dl)
    expect(isZipBytes(bytes)).toBe(true)
  })
}

test('inner CSV decrypts to the sample data with the correct password', async ({ page }) => {
  const dl = await safeExportVia(page, 'CSV', PASSWORD)
  const bytes = await downloadBytes(dl)
  const { name, data } = await unzipFirst(bytes, PASSWORD)
  expect(name).toMatch(/\.csv$/)
  const text = new TextDecoder().decode(data)
  const rows = Papa.parse<string[]>(text.trim(), { skipEmptyLines: true }).data
  expect(rows[0]).toEqual(['id', 'name', 'qty', 'price'])
  expect(rows[1]).toEqual(['1', 'Apple', '3', '0.5'])
})

test('inner SQLite is a valid .sqlite blob', async ({ page }) => {
  const dl = await safeExportVia(page, 'SQLite', PASSWORD)
  const bytes = await downloadBytes(dl)
  const { name, data } = await unzipFirst(bytes, PASSWORD)
  expect(name).toMatch(/\.sqlite$/)
  expect(new TextDecoder().decode(data.slice(0, 15))).toBe('SQLite format 3')
})

test('wrong password rejects', async ({ page }) => {
  const dl = await safeExportVia(page, 'CSV', PASSWORD)
  const bytes = await downloadBytes(dl)
  await expect(unzipFirst(bytes, 'wrong-password')).rejects.toThrow()
})

test('password dialog shows correct title for each format', async ({ page }) => {
  for (const format of ['CSV', 'Xlsx', 'SQL', 'SQLite'] as const) {
    await page.goto('/')
    await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
    await dropFile(page, 'sample.csv', 'text/csv')
    await waitForWorkbookReady(page)
    await openSafeExportDialog(page, format)
    await expect(page.locator('#password-dialog-title')).toHaveText(`Safe Export — ${format}`)
    await page.locator('#password-cancel').click()
  }
})

test('empty password shows the length error and no download', async ({ page }) => {
  await openSafeExportDialog(page, 'CSV')
  const dl = page.waitForEvent('download', { timeout: 2_000 }).catch(() => null)
  await page.locator('#password-export').click()
  await expect(page.locator('#password-error')).toHaveText(/at least 12 characters/i)
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(await dl).toBeNull()
})

test('password shorter than 12 chars shows an inline error and no download', async ({ page }) => {
  await openSafeExportDialog(page, 'CSV')
  await page.locator('#password-input').fill('short-one-1')  // 11 chars
  await page.locator('#password-confirm').fill('short-one-1')
  const dl = page.waitForEvent('download', { timeout: 2_000 }).catch(() => null)
  await page.locator('#password-export').click()
  await expect(page.locator('#password-error')).toHaveText(/at least 12 characters/i)
  await expect(page.getByRole('dialog')).toBeVisible()
  expect(await dl).toBeNull()
})

test('mismatched passwords show an inline error and no download', async ({ page }) => {
  await openSafeExportDialog(page, 'CSV')
  await page.locator('#password-input').fill('first-passphrase')
  await page.locator('#password-confirm').fill('second-passphrase')
  const dl = page.waitForEvent('download', { timeout: 2_000 }).catch(() => null)
  await page.locator('#password-export').click()
  await expect(page.locator('#password-error')).toHaveText(/match/i)
  expect(await dl).toBeNull()
})

test('pressing Enter submits when passwords match', async ({ page }) => {
  await openSafeExportDialog(page, 'CSV')
  await page.locator('#password-input').fill(PASSWORD)
  await page.locator('#password-confirm').fill(PASSWORD)
  const dl = page.waitForEvent('download', { timeout: 10_000 })
  await page.keyboard.press('Enter')
  const d = await dl
  expect(d.suggestedFilename()).toMatch(/\.zip$/)
})

test('pressing Escape cancels without downloading', async ({ page }) => {
  await openSafeExportDialog(page, 'CSV')
  const dl = page.waitForEvent('download', { timeout: 2_000 }).catch(() => null)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
  expect(await dl).toBeNull()
})

test('clicking Cancel closes the dialog without downloading', async ({ page }) => {
  await openSafeExportDialog(page, 'CSV')
  const dl = page.waitForEvent('download', { timeout: 2_000 }).catch(() => null)
  await page.locator('#password-cancel').click()
  await expect(page.getByRole('dialog')).toBeHidden()
  expect(await dl).toBeNull()
})
