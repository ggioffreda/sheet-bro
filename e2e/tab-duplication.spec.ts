import { expect, test } from '@playwright/test'
import { dropFile, readCell, waitForWorkbookReady } from './helpers'

// Chrome's "Duplicate Tab" copies sessionStorage forward. persistence.ts uses
// the Web Locks API to detect the clone: the original tab holds a lock keyed
// by its UUID, so the duplicate's `ifAvailable: true` request fails → clone
// discards the copied identity and starts fresh.
//
// We simulate this by extracting sessionStorage from page A and seeding it
// into page B via addInitScript BEFORE its goto.

test('cloned tab starts empty, original retains data, cloned identity resets', async ({ browser }) => {
  const ctx = await browser.newContext()
  const pageA = await ctx.newPage()
  await pageA.goto('/')
  await expect(pageA.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await dropFile(pageA, 'sample.csv', 'text/csv')
  await waitForWorkbookReady(pageA)

  const ss = await pageA.evaluate(() => ({
    tabId: sessionStorage.getItem('sheet-bro:tab-id'),
    tabName: sessionStorage.getItem('sheet-bro:tab-name'),
  }))
  expect(ss.tabId).not.toBeNull()

  const pageB = await ctx.newPage()
  await pageB.addInitScript((ss) => {
    if (ss.tabId) sessionStorage.setItem('sheet-bro:tab-id', ss.tabId)
    if (ss.tabName) sessionStorage.setItem('sheet-bro:tab-name', ss.tabName)
  }, ss)
  await pageB.goto('/')
  await expect(pageB.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })

  // Cloned tab must be empty (duplicate detection fired).
  await expect(pageB.locator('#empty-state')).toBeVisible()
  await expect.poll(async () => await pageB.title(), { timeout: 5_000 }).toMatch(/^Sheet-\d{4} — sheet-bro$/)

  // Cloned tab's sessionStorage identity was reset — new UUID.
  const newId = await pageB.evaluate(() => sessionStorage.getItem('sheet-bro:tab-id'))
  expect(newId).not.toBe(ss.tabId)

  // Original still holds its data.
  expect(await readCell(pageA, 'Sheet1', 'B2')).toBe('Apple')
  await pageA.reload()
  await expect(pageA.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await expect(pageA.locator('#empty-state')).toBeHidden({ timeout: 10_000 })
  expect(await readCell(pageA, 'Sheet1', 'B2')).toBe('Apple')

  await ctx.close()
})
