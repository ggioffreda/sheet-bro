import type { createUniver } from '@univerjs/presets'
import { sheetToRowsCsvSafe, type ExportCell } from './shared'

type UniverAPI = ReturnType<typeof createUniver>['univerAPI']
type UniverInstance = ReturnType<typeof createUniver>
type ActiveWorkbook = NonNullable<ReturnType<UniverInstance['univerAPI']['getActiveWorkbook']>>

export interface XlsxExportPlan {
  sheetNames: string[]
  sheetDatas: ExportCell[][][]
}

// Pure Univer-workbook → xlsx-writer input builder. Separated from the
// wrapper so the name-fallback and csvSafe composition are unit-testable
// without monkey-patching write-excel-file.
export function buildXlsxPlan(wb: ActiveWorkbook): XlsxExportPlan {
  const sheetNames: string[] = []
  const sheetDatas: ExportCell[][][] = []
  wb.getSheets().forEach((sheet, i) => {
    sheetNames.push(sheet.getSheetName() || `Sheet${i + 1}`)
    sheetDatas.push(sheetToRowsCsvSafe(sheet))
  })
  return { sheetNames, sheetDatas }
}

export async function buildXlsxExport(api: UniverAPI, stem?: string): Promise<{ bytes: Uint8Array; filename: string } | null> {
  const wb = api.getActiveWorkbook()
  if (!wb) return null
  const plan = buildXlsxPlan(wb)
  if (plan.sheetDatas.length === 0) return null
  const filename = `${stem ?? 'workbook'}.xlsx`
  const { default: writeXlsxFile } = await import('write-excel-file/browser')
  const blob = plan.sheetDatas.length === 1
    ? await writeXlsxFile(plan.sheetDatas[0], { sheet: plan.sheetNames[0] })
    : await writeXlsxFile(plan.sheetDatas, { sheets: plan.sheetNames })
  return { bytes: new Uint8Array(await blob.arrayBuffer()), filename }
}

export async function exportXlsx(api: UniverAPI, stem?: string): Promise<void> {
  const wb = api.getActiveWorkbook()
  if (!wb) return
  const plan = buildXlsxPlan(wb)
  if (plan.sheetDatas.length === 0) return
  const fileName = `${stem ?? 'workbook'}.xlsx`
  const { default: writeXlsxFile } = await import('write-excel-file/browser')

  if (plan.sheetDatas.length === 1) {
    await writeXlsxFile(plan.sheetDatas[0], {
      fileName,
      sheet: plan.sheetNames[0],
    })
  } else {
    await writeXlsxFile(plan.sheetDatas, {
      fileName,
      sheets: plan.sheetNames,
    })
  }
}
