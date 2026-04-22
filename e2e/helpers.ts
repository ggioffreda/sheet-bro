import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, type Download, type Page } from '@playwright/test'
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js'

const here = dirname(fileURLToPath(import.meta.url))

export function fixturePath(name: string): string {
  return resolve(here, 'fixtures', name)
}

/**
 * Drop a file onto the app's #csv-spreadsheet drop target.
 * Reads the fixture on the Node side, ships bytes into the page via
 * page.evaluate, rebuilds a File + DataTransfer in the browser, and
 * dispatches dragenter / dragover / drop.
 */
export async function dropFile(
  page: Page,
  fixtureName: string,
  mimeType: string,
  displayName?: string,
): Promise<void> {
  const bytes = readFileSync(fixturePath(fixtureName))
  const base64 = bytes.toString('base64')
  await page.evaluate(
    ({ base64, name, mimeType }) => {
      const bin = atob(base64)
      const u8 = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
      const file = new File([u8], name, { type: mimeType })
      const dt = new DataTransfer()
      dt.items.add(file)
      const target = document.getElementById('csv-spreadsheet')!
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }),
        )
      }
    },
    { base64, name: displayName ?? fixtureName, mimeType },
  )
}

/**
 * Wait for the app to be past cold-start (is-ready + empty-state hidden).
 * Useful after a drop completes to guarantee the workbook is up before we
 * reach into window.__sheetbro.
 */
export async function waitForWorkbookReady(page: Page): Promise<void> {
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('#empty-state')).toBeHidden({ timeout: 15_000 })
}

/**
 * Read the value of a cell, by sheet name + A1 address. Returns whatever
 * Univer's getValue() returns (usually string | number).
 */
export async function readCell(
  page: Page,
  sheet: string,
  a1: string,
): Promise<unknown> {
  return await page.evaluate(
    ({ sheet, a1 }) => {
      const api = (window as { __sheetbro?: { univerAPI: UniverApi } }).__sheetbro?.univerAPI
      if (!api) throw new Error('window.__sheetbro.univerAPI is missing — did webServer start with VITE_E2E=1?')
      const wb = api.getActiveWorkbook()
      if (!wb) throw new Error('no active workbook')
      const ws = wb.getSheetByName(sheet)
      if (!ws) throw new Error(`sheet ${sheet} not found`)
      return ws.getRange(a1).getValue()
    },
    { sheet, a1 },
  )
}

/**
 * Write a value into a cell and persist immediately (bypassing the 400ms
 * debounce). Useful in persistence-reload specs where we don't want to
 * racing the debounce against page.reload().
 */
export async function writeCell(
  page: Page,
  sheet: string,
  a1: string,
  value: string | number,
): Promise<void> {
  await page.evaluate(
    ({ sheet, a1, value }) => {
      const hook = (window as { __sheetbro?: { univerAPI: UniverApi; persistNow: () => void } })
        .__sheetbro
      if (!hook) throw new Error('window.__sheetbro missing')
      const ws = hook.univerAPI.getActiveWorkbook()!.getSheetByName(sheet)!
      ws.getRange(a1).setValue(value)
      hook.persistNow()
    },
    { sheet, a1, value },
  )
}

/**
 * Return the list of sheet names in the active workbook.
 */
export async function listSheets(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const api = (window as { __sheetbro?: { univerAPI: UniverApi } }).__sheetbro?.univerAPI
    if (!api) throw new Error('window.__sheetbro missing')
    return api.getActiveWorkbook()!.getSheets().map((s: { getSheetName: () => string }) => s.getSheetName())
  })
}

/**
 * Open the File ribbon tab → Export submenu and click the named export
 * action, returning the captured Download. Watches for the download before
 * firing the click to avoid the race against Blob creation inside the
 * exporter.
 *
 * Selector notes:
 * - The ribbon tab is `role=tab`.
 * - The SUBITEMS container is a `<div>` (Radix `asChild` on a div, so no
 *   implicit ARIA role). We target it by `data-u-command` which the ribbon
 *   sets to the menu id.
 * - The dropdown items are rendered by Radix as `role=menuitem`.
 */
export async function exportVia(
  page: Page,
  menu: 'CSV' | 'Xlsx' | 'SQL' | 'SQLite',
): Promise<Download> {
  await page.getByRole('tab', { name: 'File' }).click()
  // Univer renders an invisible offscreen copy of the ribbon for measurement,
  // so scope to the visible toolbar (role=toolbar) to avoid strict-mode
  // violation on [data-u-command].
  await page.getByRole('toolbar').locator('[data-u-command="sheet-bro.file.export"]').click()
  // `exact: true` — "SQL" is a substring of "SQLite" so the default partial
  // match would flip-flop between the two menuitems.
  const item = page.getByRole('menuitem', { name: menu, exact: true })
  await item.waitFor({ state: 'visible' })
  const dl = page.waitForEvent('download', { timeout: 15_000 })
  await item.click()
  return await dl
}

export async function downloadBytes(dl: Download): Promise<Buffer> {
  const path = await dl.path()
  if (!path) throw new Error('no download path')
  return readFileSync(path)
}

export async function downloadText(dl: Download): Promise<string> {
  return (await downloadBytes(dl)).toString('utf8')
}

type ExportFormat = 'CSV' | 'Xlsx' | 'SQL' | 'SQLite'

/**
 * Open File → Safe Export → <format> to bring up the password dialog.
 * Leaves the dialog open; use the returned locator to fill fields.
 */
export async function openSafeExportDialog(page: Page, format: ExportFormat): Promise<void> {
  await page.getByRole('tab', { name: 'File' }).click()
  await page.getByRole('toolbar').locator('[data-u-command="sheet-bro.file.safe-export"]').click()
  // Wait for the Safe Export dropdown to render before clicking — the click
  // auto-wait occasionally resolves against a stale hidden menuitem.
  const item = page.getByRole('menuitem', { name: format, exact: true })
  await item.waitFor({ state: 'visible' })
  await item.click()
  // `#password-dialog` is a zero-size wrapper; the inner role=dialog has real
  // dimensions. Assert visibility on the role=dialog instead.
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 })
}

/**
 * Full Safe Export flow: open dialog, fill passwords, click Export, capture download.
 */
export async function safeExportVia(
  page: Page,
  format: ExportFormat,
  password: string,
  confirm: string = password,
): Promise<Download> {
  await openSafeExportDialog(page, format)
  await page.locator('#password-input').fill(password)
  await page.locator('#password-confirm').fill(confirm)
  const dl = page.waitForEvent('download', { timeout: 15_000 })
  await page.locator('#password-export').click()
  return await dl
}

/**
 * Open File → Clean Up → <scope>, handling the in-app #confirm-dialog.
 * `accept=true` clicks Delete, `accept=false` clicks Cancel.
 */
export async function clickCleanup(
  page: Page,
  scope: 'This Tab' | 'All Tabs',
  accept: boolean,
): Promise<void> {
  await page.getByRole('tab', { name: 'File' }).click()
  await page.getByRole('toolbar').locator('[data-u-command="sheet-bro.file.cleanup"]').click()
  await page.getByRole('menuitem', { name: scope, exact: true }).click()
  // `#confirm-dialog` is a zero-size wrapper; wait for the inner role=dialog
  // (same pattern the password dialog uses).
  const title = scope === 'This Tab' ? 'Clean Up This Tab' : 'Clean Up All Tabs'
  await expect(page.getByRole('dialog', { name: title })).toBeVisible({ timeout: 5_000 })
  await page.locator(accept ? '#confirm-ok' : '#confirm-cancel').click()
  await expect(page.locator('#confirm-dialog')).toHaveAttribute('hidden', '', { timeout: 5_000 })
}

export function isZipBytes(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

/**
 * Extract the first entry from a (possibly password-protected) ZIP buffer.
 * Throws if the password is wrong or no entry exists.
 */
export async function unzipFirst(
  bytes: Buffer,
  password: string,
): Promise<{ name: string; data: Uint8Array }> {
  const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(bytes)), { password })
  try {
    const entries = await reader.getEntries()
    const entry = entries.find((e) => !e.directory)
    if (!entry?.getData) throw new Error('zip has no file entries')
    const data = await entry.getData(new Uint8ArrayWriter())
    return { name: entry.filename, data }
  } finally {
    await reader.close()
  }
}

/**
 * Wait for #notify to become visible with text matching the regex.
 */
export async function expectNotify(
  page: Page,
  textRegex: RegExp,
  timeoutMs = 5_000,
): Promise<void> {
  const notify = page.locator('#notify')
  await expect(notify).toBeVisible({ timeout: timeoutMs })
  await expect(notify).toHaveText(textRegex, { timeout: timeoutMs })
}

/**
 * Return `document.title` with the trailing " — sheet-bro" suffix stripped.
 */
export async function currentTitleStem(page: Page): Promise<string> {
  const title = await page.title()
  return title.replace(/ — sheet-bro$/, '')
}

// Minimal Univer API shape that the helpers need. We don't import from
// @univerjs/presets here because this file runs under the Playwright node
// runner, not in-browser — we just declare the duck-type.
interface UniverApi {
  getActiveWorkbook: () => {
    getSheets: () => Array<{ getSheetName: () => string }>
    getSheetByName: (name: string) => {
      getRange: (a1: string) => {
        getValue: () => unknown
        setValue: (v: string | number) => void
      }
    } | null
  } | null
}
