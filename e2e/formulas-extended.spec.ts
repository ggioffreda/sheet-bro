import { expect, test } from '@playwright/test'
import { dropFile, readCell, waitForWorkbookReady, writeCell } from './helpers'

// Complements formulas.spec.ts (SUM + multiplication) with coverage for the
// other common formula families: AVERAGE / COUNT / MIN / MAX / IF. Univer
// evaluates formulas asynchronously, so every assertion polls the cell
// until the value lands rather than reading once.

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await dropFile(page, 'sample.csv', 'text/csv')
  await waitForWorkbookReady(page)
})

// sample.csv quantities in C2..C5: 3, 5, 2, 1.

test('AVERAGE over the qty column returns the mean', async ({ page }) => {
  await writeCell(page, 'Sheet1', 'E1', '=AVERAGE(C2:C5)')
  // (3 + 5 + 2 + 1) / 4 = 2.75
  await expect.poll(async () => await readCell(page, 'Sheet1', 'E1'), {
    timeout: 10_000,
  }).toBe(2.75)
})

test('COUNT over the qty column returns the count of numeric cells', async ({ page }) => {
  await writeCell(page, 'Sheet1', 'E1', '=COUNT(C2:C5)')
  await expect.poll(async () => await readCell(page, 'Sheet1', 'E1'), {
    timeout: 10_000,
  }).toBe(4)
})

test('MIN and MAX over the qty column return the extremes', async ({ page }) => {
  await writeCell(page, 'Sheet1', 'E1', '=MIN(C2:C5)')
  await writeCell(page, 'Sheet1', 'E2', '=MAX(C2:C5)')
  await expect.poll(async () => await readCell(page, 'Sheet1', 'E1'), {
    timeout: 10_000,
  }).toBe(1)
  await expect.poll(async () => await readCell(page, 'Sheet1', 'E2'), {
    timeout: 10_000,
  }).toBe(5)
})

test('IF returns the true-branch string when the condition matches', async ({ page }) => {
  // C2 = 3 → >=3 is true → returns "yes"
  await writeCell(page, 'Sheet1', 'E1', '=IF(C2>=3,"yes","no")')
  // C4 = 2 → >=3 is false → returns "no"
  await writeCell(page, 'Sheet1', 'E2', '=IF(C4>=3,"yes","no")')
  await expect.poll(async () => await readCell(page, 'Sheet1', 'E1'), {
    timeout: 10_000,
  }).toBe('yes')
  await expect.poll(async () => await readCell(page, 'Sheet1', 'E2'), {
    timeout: 10_000,
  }).toBe('no')
})
