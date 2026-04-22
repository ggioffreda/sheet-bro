import { expect, test } from '@playwright/test'
import {
  downloadText,
  dropFile,
  exportVia,
  waitForWorkbookReady,
} from './helpers'

// The csvSafe contract: any string starting with =, +, -, @, \t, or \r in
// an exported cell gets prefixed with a leading apostrophe so Excel /
// Sheets / LibreOffice treat it as text rather than evaluating it as a
// formula or command. This test is load-bearing defence against the
// OWASP "CSV injection" class of bugs — regressing it puts every user
// who opens an exported file at risk.

test('CSV export prefixes =, +, -, @, \\t, \\r payloads with a single quote', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await dropFile(page, 'injection.csv', 'text/csv')
  await waitForWorkbookReady(page)

  const dl = await exportVia(page, 'CSV')
  const text = await downloadText(dl)

  // Every known-risky payload from the fixture must be prefixed with a
  // single quote so the receiving app treats it as text, not a formula.
  expect(text).toContain("'=cmd|")
  expect(text).toContain("'+1+1")
  expect(text).toContain("'-SUM(A1:A10)")
  expect(text).toContain("'@SUM(A1)")
  // Safe-text row must stay untouched.
  expect(text).toContain('safe text')
  // None of the risky prefixes should appear unprefixed in a cell.
  const lines = text.trim().split(/\r?\n/)
  for (const line of lines.slice(1)) {
    const cells = line.split(',')
    for (const cell of cells) {
      // A cell starts with one of =, +, -, @, \t, \r ONLY if the leading
      // char is a quote (the escape we just added) — otherwise regression.
      // Bare numbers like "1" are fine.
      if (/^[=+\-@\t\r]/.test(cell)) {
        throw new Error(`unescaped risky cell: ${JSON.stringify(cell)}`)
      }
    }
  }
})
