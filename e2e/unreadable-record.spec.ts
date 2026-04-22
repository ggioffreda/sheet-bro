import { expect, test } from '@playwright/test'
import {
  dropFile,
  expectNotify,
  readCell,
  waitForWorkbookReady,
  writeCell,
} from './helpers'

// Covers the fallback branch at src/app.ts:127-167 — the most important
// untested path in the whole repo per the audit. If decryption of the
// persisted record fails on cold start, the app must:
//   1. Surface a sticky notify toast.
//   2. Load an empty workbook.
//   3. Suppress the command listener so the empty fallback does NOT
//      overwrite the still-encrypted record.
//   4. Re-arm the listener only when the user drops a fresh file.

async function getTabId(page: import('@playwright/test').Page): Promise<string> {
  const id = await page.evaluate(() => {
    const hook = (window as { __sheetbro?: { getTabId: () => string | null } }).__sheetbro
    if (!hook) throw new Error('window.__sheetbro missing')
    return hook.getTabId()
  })
  if (!id) throw new Error('no tab id — persistence did not initialise')
  return id
}

async function corruptRecord(page: import('@playwright/test').Page, tabId: string): Promise<void> {
  // Open the 'workbooks' store in the 'sheet-bro' IndexedDB, flip one byte
  // of the ciphertext for this tab, and write the record back. The AES-GCM
  // tag will fail on the next load, driving the unreadable-record branch.
  await page.evaluate(async (tabId) => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('sheet-bro', 3)
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('workbooks', 'readwrite')
        const store = tx.objectStore('workbooks')
        const getReq = store.get(tabId)
        getReq.onsuccess = () => {
          const record = getReq.result
          if (!record) {
            db.close()
            reject(new Error('no record to corrupt'))
            return
          }
          const ct = new Uint8Array(record.ciphertext)
          ct[Math.min(ct.length - 1, 32)] ^= 0xff
          record.ciphertext = ct.buffer
          store.put(record, tabId)
        }
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => { db.close(); reject(tx.error) }
      }
      req.onerror = () => reject(req.error)
    })
  }, tabId)
}

async function peekCiphertextLength(page: import('@playwright/test').Page, tabId: string): Promise<number | null> {
  return await page.evaluate(async (tabId) => {
    return await new Promise<number | null>((resolve, reject) => {
      const req = indexedDB.open('sheet-bro', 3)
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('workbooks', 'readonly')
        const getReq = tx.objectStore('workbooks').get(tabId)
        getReq.onsuccess = () => {
          const record = getReq.result
          db.close()
          resolve(record ? new Uint8Array(record.ciphertext).byteLength : null)
        }
        getReq.onerror = () => { db.close(); reject(getReq.error) }
      }
      req.onerror = () => reject(req.error)
    })
  }, tabId)
}

test('a corrupted persisted record falls back to empty, warns, and does not overwrite', async ({ page }) => {
  // Seed: drop a CSV, persist immediately.
  await page.goto('/')
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  await dropFile(page, 'sample.csv', 'text/csv')
  await waitForWorkbookReady(page)

  const tabId = await getTabId(page)
  // Force a persist so a record definitely exists.
  await writeCell(page, 'Sheet1', 'F1', 'sentinel')
  // Poll: persistence runs through a 400ms debounce, but writeCell calls
  // persistNow() which resolves the save. Still, the underlying IndexedDB
  // put is a transaction — give it a tick.
  await expect.poll(async () => await peekCiphertextLength(page, tabId), {
    timeout: 5_000,
  }).not.toBeNull()
  const originalCtLen = await peekCiphertextLength(page, tabId)
  expect(originalCtLen).not.toBeNull()

  // Corrupt the ciphertext directly in IndexedDB, then reload.
  await corruptRecord(page, tabId)
  await page.reload()

  // Assertion 1: sticky toast appears with the expected wording.
  await expectNotify(page, /(could not|couldn'?t).*decrypt/i, 10_000)

  // Assertion 2: workbook loaded (cold-start finished) but cell F1 (the
  // sentinel we wrote before the crash) is NOT present — fallback empty.
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({ timeout: 15_000 })
  // The sentinel should not have survived into the fallback workbook.
  const sentinelAfter = await page.evaluate(() => {
    const api = (window as { __sheetbro?: { univerAPI: { getActiveWorkbook: () => { getSheets: () => Array<{ getRange: (a: string) => { getValue: () => unknown } }> } | null } } }).__sheetbro?.univerAPI
    if (!api) return '__no_api__'
    const wb = api.getActiveWorkbook()
    if (!wb) return '__no_wb__'
    const sheets = wb.getSheets()
    if (sheets.length === 0) return '__no_sheets__'
    // Scan the first sheet for a 'sentinel' — don't assume F1 exists in
    // the fallback workbook's range.
    try {
      return sheets[0].getRange('F1').getValue()
    } catch {
      return null
    }
  })
  expect(sentinelAfter).not.toBe('sentinel')

  // Assertion 3: the corrupted record is still in IndexedDB (the command
  // listener was suppressed, so the fallback empty workbook didn't
  // overwrite it). Ciphertext length is our proxy for "the same record".
  const afterReloadLen = await peekCiphertextLength(page, tabId)
  expect(afterReloadLen).toBe(originalCtLen)

  // Assertion 4: dropping a fresh file re-arms the listener and the new
  // data persists (ciphertext length will differ from the corrupted one).
  await dropFile(page, 'sample.csv', 'text/csv')
  await waitForWorkbookReady(page)
  await writeCell(page, 'Sheet1', 'F1', 'sentinel-2')
  await expect.poll(async () => await peekCiphertextLength(page, tabId), {
    timeout: 5_000,
  }).not.toBe(originalCtLen)
  // And the value round-trips after the fresh drop.
  expect(await readCell(page, 'Sheet1', 'F1')).toBe('sentinel-2')
})
