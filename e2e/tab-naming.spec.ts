import { expect, test } from '@playwright/test'
import { currentTitleStem, dropFile, waitForWorkbookReady } from './helpers'

// Exercises: default name allocator (Sheet-NNNN via Web Lock), file-based name
// derivation (fileBasedTabName), document.title wiring, the cross-tab registry
// in localStorage (sheet-bro:tab:<id>), and the reload preservation via
// sessionStorage (sheet-bro:tab-name).

test('cold start assigns document.title matching Sheet-NNNN — sheet-bro', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  // Title may be the literal 'sheet-bro' for a split-second before initTabName
  // resolves, so poll via expect.
  await expect.poll(async () => await page.title(), { timeout: 5_000 }).toMatch(/^Sheet-\d{4} — sheet-bro$/)
})

test('dropping a CSV updates the title to the file-based name', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await dropFile(page, 'sample.csv', 'text/csv')
  await waitForWorkbookReady(page)
  await expect.poll(async () => await page.title(), { timeout: 5_000 }).toMatch(
    /^Sample-\d{2}-[A-Z][a-z]{2}-\d{2}-\d{2} — sheet-bro$/,
  )
})

test('filename punctuation and non-ASCII are sanitized', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  // The fixture file on disk is named weird-name.csv; we override the File
  // name passed into the drop to exercise fileBasedTabName with punctuation,
  // spaces, and accented characters.
  await dropFile(page, 'weird-name.csv', 'text/csv', 'Ventas (2026)_Q1.csv')
  await waitForWorkbookReady(page)
  const stem = await currentTitleStem(page)
  // After sanitization: no spaces, parentheses, underscores, or dots in the stem.
  expect(stem).toMatch(/^[A-Z][A-Za-z0-9-]*-\d{2}-[A-Z][a-z]{2}-\d{2}-\d{2}$/)
  expect(stem).not.toContain('(')
  expect(stem).not.toContain(' ')
  expect(stem).not.toContain('_')
})

test('two tabs in the same context get distinct sequential Sheet-NNNN names', async ({ browser }) => {
  const ctx = await browser.newContext()
  const pageA = await ctx.newPage()
  const pageB = await ctx.newPage()
  await pageA.goto('/')
  await pageB.goto('/')
  await expect(pageA.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await expect(pageB.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  const titleA = await pageA.title()
  const titleB = await pageB.title()
  const reA = /^Sheet-(\d{4}) — sheet-bro$/.exec(titleA)
  const reB = /^Sheet-(\d{4}) — sheet-bro$/.exec(titleB)
  expect(reA).not.toBeNull()
  expect(reB).not.toBeNull()
  expect(reA![1]).not.toBe(reB![1])
  await ctx.close()
})

test('another tab in the same context appears in localStorage registry', async ({ browser }) => {
  const ctx = await browser.newContext()
  const pageA = await ctx.newPage()
  await pageA.goto('/')
  await expect(pageA.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await dropFile(pageA, 'sample.csv', 'text/csv')
  await waitForWorkbookReady(pageA)
  const pageB = await ctx.newPage()
  await pageB.goto('/')
  await expect(pageB.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  // Page A must see page B's registry entry. The cross-tab update is delivered
  // via the `storage` event — poll to absorb that latency.
  const idB = await pageB.evaluate(() => (window as unknown as { __sheetbro: { getTabId: () => string | null } }).__sheetbro.getTabId())
  expect(idB).not.toBeNull()
  await expect.poll(
    async () => await pageA.evaluate(
      (id: string) => (window as unknown as { __sheetbro: { readTabRegistry: () => Array<{ tabId: string; name: string }> } })
        .__sheetbro.readTabRegistry().some((e) => e.tabId === id),
      idB!,
    ),
    { timeout: 5_000 },
  ).toBe(true)
  await ctx.close()
})

test('reload preserves the file-based tab name', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await dropFile(page, 'sample.csv', 'text/csv')
  await waitForWorkbookReady(page)
  const before = await page.title()
  await page.reload()
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await expect.poll(async () => await page.title(), { timeout: 5_000 }).toBe(before)
})
