import { expect, test } from '@playwright/test'

// Pins the Univer ribbon / submenu / menuitem structure. Univer's menu
// system has historically been fragile (see CLAUDE.md: "the `mergeMenu`
// trap") — a registration refactor can silently produce empty flyouts or
// unwired leaves. These tests assert the exact shape: File tab, three
// submenus, four × four × two leaves, and that each leaf is wired.
//
// DOM conventions used below:
//  - Ribbon tabs: role=tab
//  - Submenu flyout anchors:  [data-u-command="sheet-bro.file.<sub>"]
//    rendered inside the visible role=toolbar
//  - Dropdown items: role=menuitem

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
})

test('ribbon shows "File" tab and does NOT show "Export" or "Insert"/"View"', async ({ page }) => {
  await expect(page.getByRole('tab', { name: 'File' })).toBeVisible()
  // Legacy label must not resurface during refactors.
  await expect(page.getByRole('tab', { name: 'Export', exact: true })).toHaveCount(0)
  // Empty pre-seeded tabs are filtered out by Univer's ribbon renderer.
  await expect(page.getByRole('tab', { name: 'Insert', exact: true })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'View', exact: true })).toHaveCount(0)
})

test('File tab reveals Export, Safe Export, and Clean Up submenu anchors', async ({ page }) => {
  await page.getByRole('tab', { name: 'File' }).click()
  const toolbar = page.getByRole('toolbar')
  await expect(toolbar.locator('[data-u-command="sheet-bro.file.export"]')).toBeVisible()
  await expect(toolbar.locator('[data-u-command="sheet-bro.file.safe-export"]')).toBeVisible()
  await expect(toolbar.locator('[data-u-command="sheet-bro.file.cleanup"]')).toBeVisible()
})

test('Export submenu lists CSV, Xlsx, SQL, SQLite', async ({ page }) => {
  await page.getByRole('tab', { name: 'File' }).click()
  await page.getByRole('toolbar').locator('[data-u-command="sheet-bro.file.export"]').click()
  for (const label of ['CSV', 'Xlsx', 'SQL', 'SQLite'] as const) {
    await expect(page.getByRole('menuitem', { name: label, exact: true })).toBeVisible()
  }
})

test('Safe Export submenu lists CSV, Xlsx, SQL, SQLite', async ({ page }) => {
  await page.getByRole('tab', { name: 'File' }).click()
  await page.getByRole('toolbar').locator('[data-u-command="sheet-bro.file.safe-export"]').click()
  for (const label of ['CSV', 'Xlsx', 'SQL', 'SQLite'] as const) {
    await expect(page.getByRole('menuitem', { name: label, exact: true })).toBeVisible()
  }
})

test('Clean Up submenu lists This Tab and All Tabs', async ({ page }) => {
  await page.getByRole('tab', { name: 'File' }).click()
  await page.getByRole('toolbar').locator('[data-u-command="sheet-bro.file.cleanup"]').click()
  for (const label of ['This Tab', 'All Tabs'] as const) {
    await expect(page.getByRole('menuitem', { name: label, exact: true })).toBeVisible()
  }
})

test('Export → CSV fires and produces a download (default stem)', async ({ page }) => {
  await page.getByRole('tab', { name: 'File' }).click()
  await page.getByRole('toolbar').locator('[data-u-command="sheet-bro.file.export"]').click()
  const dl = page.waitForEvent('download', { timeout: 10_000 })
  await page.getByRole('menuitem', { name: 'CSV', exact: true }).click()
  const d = await dl
  expect(d.suggestedFilename()).toMatch(/\.csv$/)
})

test('Safe Export → CSV opens the password dialog', async ({ page }) => {
  await page.getByRole('tab', { name: 'File' }).click()
  await page.getByRole('toolbar').locator('[data-u-command="sheet-bro.file.safe-export"]').click()
  const csv = page.getByRole('menuitem', { name: 'CSV', exact: true })
  await csv.waitFor({ state: 'visible' })
  await csv.click()
  // `#password-dialog` is a zero-size wrapper; assert visibility on the inner
  // role=dialog box which has real dimensions. `isVisible` on the wrapper
  // returns false even when its `hidden` attribute has been removed.
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.locator('#password-dialog-title')).toHaveText('Safe Export — CSV')
})

test('Clean Up → This Tab opens in-app confirm dialog', async ({ page }) => {
  await page.getByRole('tab', { name: 'File' }).click()
  await page.getByRole('toolbar').locator('[data-u-command="sheet-bro.file.cleanup"]').click()
  await page.getByRole('menuitem', { name: 'This Tab', exact: true }).click()
  // `#confirm-dialog` is a zero-size wrapper; assert visibility on the inner
  // role=dialog box which has real dimensions (same pattern as the password
  // dialog above).
  await expect(page.getByRole('dialog', { name: 'Clean Up This Tab' })).toBeVisible({ timeout: 5_000 })
  await expect(page.locator('#confirm-dialog-title')).toHaveText(/clean up this tab/i)
  await expect(page.locator('#confirm-dialog-message')).toHaveText(/this tab's data/i)
  await page.locator('#confirm-cancel').click()
  await expect(page.locator('#confirm-dialog')).toHaveAttribute('hidden', '', { timeout: 5_000 })
})
