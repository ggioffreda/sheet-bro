import { expect, test } from '@playwright/test'
import { clickCleanup, currentTitleStem, dropFile, expectNotify, waitForWorkbookReady } from './helpers'

// Exercises the Clean Up menu actions:
//  - in-app #confirm-dialog prompt (click Delete/Cancel button)
//  - resetToEmpty() post-state: empty-state visible, title='sheet-bro'
//  - BroadcastChannel broadcast on "All Tabs" cleanup
//  - Cancel path leaves data untouched
//  - Encryption barrier: post-cleanup, a fresh drop must still load on reload

test('Clean Up → This Tab, confirm wipes data and resets title', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await dropFile(page, 'sample.csv', 'text/csv')
  await waitForWorkbookReady(page)
  await clickCleanup(page, 'This Tab', true)
  await expect(page.locator('#empty-state')).toBeVisible({ timeout: 5_000 })
  await expect.poll(async () => await page.title(), { timeout: 5_000 }).toMatch(/^Sheet-\d{4} — sheet-bro$|^sheet-bro$/)
  await expectNotify(page, /this tab's data and encryption key have been cleared/i)
})

test('Clean Up → This Tab, cancel leaves data intact', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await dropFile(page, 'sample.csv', 'text/csv')
  await waitForWorkbookReady(page)
  const before = await page.title()
  await clickCleanup(page, 'This Tab', false)
  // State must not change — overlay stays hidden and title is preserved.
  await expect(page.locator('#empty-state')).toBeHidden()
  await expect(page).toHaveTitle(before)
  const stem = await currentTitleStem(page)
  expect(stem).toMatch(/^Sample-/)
})

test('Clean Up → All Tabs, confirm wipes data and emits all-tabs notify', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await dropFile(page, 'sample.csv', 'text/csv')
  await waitForWorkbookReady(page)
  await clickCleanup(page, 'All Tabs', true)
  await expect(page.locator('#empty-state')).toBeVisible({ timeout: 5_000 })
  await expectNotify(page, /all tab data and encryption keys have been cleared/i)
})

test('Clean Up → All Tabs broadcasts to peer tabs in the same context', async ({ browser }) => {
  const ctx = await browser.newContext()
  const pageA = await ctx.newPage()
  const pageB = await ctx.newPage()
  await pageA.goto('/')
  await pageB.goto('/')
  await expect(pageA.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await expect(pageB.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await dropFile(pageA, 'sample.csv', 'text/csv')
  await waitForWorkbookReady(pageA)
  await dropFile(pageB, 'sample.csv', 'text/csv')
  await waitForWorkbookReady(pageB)
  await clickCleanup(pageA, 'All Tabs', true)
  // Page B, which was loaded with data, receives the BroadcastChannel message
  // and transitions to the empty state with the peer-cleanup notify.
  await expect(pageB.locator('#empty-state')).toBeVisible({ timeout: 5_000 })
  await expectNotify(pageB, /all tab data was cleared from another tab/i)
  await ctx.close()
})

test('Clean Up → All Tabs lists affected tabs from the cross-tab registry', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await dropFile(page, 'sample.csv', 'text/csv')
  await waitForWorkbookReady(page)
  // Seed three peer tabs into the localStorage registry. Same-document setItem
  // does NOT fire `storage` events, so these are invisible to the running tab
  // until cleanupAllTabs() reads them via readAllTabRegistry().
  await page.evaluate(() => {
    // Seed lastSeen values greater than Date.now() so peers sort ahead of the
    // current tab's auto-refreshed timestamp.
    const base = Date.now() + 60_000
    const peers = [
      { tabId: 'peer-a', name: 'Alpha-01-Jan-00-00', lastSeen: base + 1 },
      { tabId: 'peer-b', name: 'Bravo-01-Jan-00-00', lastSeen: base + 3 },
      { tabId: 'peer-c', name: '', lastSeen: base + 2 },
    ]
    for (const p of peers) localStorage.setItem(`sheet-bro:tab:${p.tabId}`, JSON.stringify(p))
  })
  await page.getByRole('tab', { name: 'File' }).click()
  await page.getByRole('toolbar').locator('[data-u-command="sheet-bro.file.cleanup"]').click()
  await page.getByRole('menuitem', { name: 'All Tabs', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Clean Up All Tabs' })
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.locator('#confirm-dialog-message')).toContainText(/delete data and encryption keys for 4 tabs/i)
  const items = dialog.locator('#confirm-dialog-list li')
  await expect(items).toHaveCount(4)
  // Sorted newest-first by lastSeen; peer-c has a blank name → "(unnamed tab)".
  await expect(items.nth(0)).toHaveText('Bravo-01-Jan-00-00')
  await expect(items.nth(1)).toHaveText('(unnamed tab)')
  await expect(items.nth(2)).toHaveText('Alpha-01-Jan-00-00')
  await expect(items.nth(3)).toHaveText(/^Sample-/)
  await page.locator('#confirm-cancel').click()
  await expect(page.locator('#confirm-dialog')).toHaveAttribute('hidden', '', { timeout: 5_000 })
  // Cancel leaves registry entries intact.
  const surviving = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith('sheet-bro:tab:')).length,
  )
  expect(surviving).toBeGreaterThanOrEqual(4)
})

test('Clean Up → All Tabs truncates to 8 entries with "+N more…"', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await dropFile(page, 'sample.csv', 'text/csv')
  await waitForWorkbookReady(page)
  await page.evaluate(() => {
    // 10 peers + the current tab = 11 affected. Cap is 8, so we show 7 + "+N more…".
    for (let i = 0; i < 10; i++) {
      const entry = { tabId: `peer-${i}`, name: `Peer-${String(i).padStart(2, '0')}`, lastSeen: 10_000 - i }
      localStorage.setItem(`sheet-bro:tab:${entry.tabId}`, JSON.stringify(entry))
    }
  })
  await page.getByRole('tab', { name: 'File' }).click()
  await page.getByRole('toolbar').locator('[data-u-command="sheet-bro.file.cleanup"]').click()
  await page.getByRole('menuitem', { name: 'All Tabs', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Clean Up All Tabs' })
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.locator('#confirm-dialog-message')).toContainText(/for 11 tabs/i)
  const items = dialog.locator('#confirm-dialog-list li')
  await expect(items).toHaveCount(8)
  await expect(items.last()).toHaveText('+4 more…')
  await page.locator('#confirm-cancel').click()
})

test('Clean Up → This Tab does NOT show the affected-tabs list', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await dropFile(page, 'sample.csv', 'text/csv')
  await waitForWorkbookReady(page)
  await page.evaluate(() => {
    localStorage.setItem(
      'sheet-bro:tab:peer-x',
      JSON.stringify({ tabId: 'peer-x', name: 'Peer', lastSeen: 1 }),
    )
  })
  await page.getByRole('tab', { name: 'File' }).click()
  await page.getByRole('toolbar').locator('[data-u-command="sheet-bro.file.cleanup"]').click()
  await page.getByRole('menuitem', { name: 'This Tab', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Clean Up This Tab' })
  await expect(dialog).toBeVisible({ timeout: 5_000 })
  await expect(dialog.locator('#confirm-dialog-list')).toBeHidden()
  await page.locator('#confirm-cancel').click()
})

test('after Clean Up, a fresh drop persists and reloads cleanly (new key)', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await dropFile(page, 'sample.csv', 'text/csv')
  await waitForWorkbookReady(page)
  await clickCleanup(page, 'This Tab', true)
  await expect(page.locator('#empty-state')).toBeVisible({ timeout: 5_000 })
  // Drop again — this exercises the re-initStorage() path in resetToEmpty().
  await dropFile(page, 'sample.csv', 'text/csv')
  await waitForWorkbookReady(page)
  await page.reload()
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  // If decryption fails after a cleanup-then-reload, #notify goes sticky with
  // a "saved data could not be decrypted" warning and empty-state stays
  // visible. Asserting the opposite proves we issued a fresh key cleanly.
  await expect(page.locator('#empty-state')).toBeHidden({ timeout: 10_000 })
})
