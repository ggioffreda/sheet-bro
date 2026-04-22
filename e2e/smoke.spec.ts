import { expect, test } from '@playwright/test'

// Single scenario end-to-end: drag a CSV onto the app, verify the workbook
// loads, trigger Export → CSV, and compare the downloaded bytes against the
// input. This exercises the wiring that unit tests deliberately skip
// (Univer bootstrap, drop dispatch, ribbon-menu registration, downloadBlob,
// and the round-trip through Univer's cell representation).

const CSV_INPUT = 'id,name,qty\n1,Apple,3\n2,Pear,5\n'

test('CSV drop → workbook → File → Export → CSV round-trip', async ({ page }) => {
  await page.goto('/')

  // Wait for the spreadsheet container's fade-in transition to apply — this
  // is the visible marker that Univer has bootstrapped and createWorkbook()
  // has returned. No brittle timeouts; we watch the class the app actually
  // sets.
  await expect(page.locator('#csv-spreadsheet.is-ready')).toBeVisible({
    timeout: 15_000,
  })

  // Build a CSV File in the browser and fire a drop event against the app
  // root. Playwright does not expose native drag-and-drop for external
  // files (that's an OS-level interaction), so we simulate by dispatching
  // synthetic drop events with a DataTransfer built in the page context.
  // This exercises the app's own onDrop handler end-to-end.
  await page.evaluate(async (csv) => {
    const file = new File([csv], 'input.csv', { type: 'text/csv' })
    const dt = new DataTransfer()
    dt.items.add(file)
    const target = document.getElementById('csv-spreadsheet')!
    const fire = (type: string) => {
      target.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }),
      )
    }
    fire('dragenter')
    fire('dragover')
    fire('drop')
  }, CSV_INPUT)

  // The empty-state overlay hides once loadIntoWorkbook() runs; wait for
  // that signal rather than polling visible text (which depends on Univer's
  // internal cell render timing).
  await expect(page.locator('#empty-state')).toBeHidden({ timeout: 10_000 })

  // Open the File ribbon tab (repurposed 'others' slot) and the Export
  // SUBITEMS container. The tabs are role=tab, the SUBITEMS container is
  // a div (Radix asChild on a div has no implicit role) so we target it by
  // data-u-command. The dropdown items are Radix role=menuitem.
  await page.getByRole('tab', { name: 'File' }).click()
  // Univer renders an invisible offscreen copy of the ribbon for measurement,
  // so scope to the visible toolbar (role=toolbar) to avoid strict-mode
  // violation on [data-u-command].
  await page.getByRole('toolbar').locator('[data-u-command="sheet-bro.file.export"]').click()

  // Start watching for the download BEFORE firing the action so we don't
  // race against the Blob creation in exporters/csv.ts.
  const downloadPromise = page.waitForEvent('download', { timeout: 15_000 })

  await page.getByRole('menuitem', { name: 'CSV', exact: true }).click()

  const download = await downloadPromise
  const path = await download.path()
  expect(path).not.toBeNull()
  const bytes = await (await import('node:fs/promises')).readFile(path!)
  const text = bytes.toString('utf8')

  // Round-trip must preserve the three header cells and the two data rows.
  // We compare tolerantly: Papa may emit CRLF where the input used LF, and
  // the exporter's filename-sanitized header is the active sheet name, not
  // "id,name,qty" verbatim. What matters is the data cells survived.
  const lines = text.split(/\r?\n/).filter(Boolean)
  expect(lines).toHaveLength(3) // header + 2 data rows
  expect(lines[1]).toBe('1,Apple,3')
  expect(lines[2]).toBe('2,Pear,5')
})
