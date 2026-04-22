import type { createUniver } from '@univerjs/presets'

type UniverAPI = ReturnType<typeof createUniver>['univerAPI']

export type FakeCell = string | number | boolean | null

export interface FakeSheetData {
  name: string
  rows: FakeCell[][]
}

// Minimal duck-typed UniverAPI that satisfies the seams used by the exporter
// wrappers: getActiveWorkbook(), workbook.getSheets() / getActiveSheet(),
// sheet.getSheetName() / getLastRow() / getLastColumn() / getRange(...). No
// caller uses more, so we model no more.
export function buildFakeUniverAPI(sheets: FakeSheetData[] | null): UniverAPI {
  if (sheets === null) {
    return { getActiveWorkbook: () => null } as unknown as UniverAPI
  }
  const fakeSheets = sheets.map(buildFakeSheet)
  const workbook = {
    getSheets: () => fakeSheets,
    getActiveSheet: () => fakeSheets[0] ?? null,
  }
  return { getActiveWorkbook: () => workbook } as unknown as UniverAPI
}

function buildFakeSheet({ name, rows }: FakeSheetData) {
  const lastRow = rows.length - 1
  const lastCol = rows.reduce((m, r) => Math.max(m, r.length), 0) - 1
  return {
    getSheetName: () => name,
    getLastRow: () => lastRow,
    getLastColumn: () => lastCol,
    getRange: (_startRow: number, _startCol: number, rowCount: number, colCount: number) => ({
      getValues: () => {
        const out: FakeCell[][] = []
        for (let r = 0; r < rowCount; r++) {
          const row: FakeCell[] = []
          for (let c = 0; c < colCount; c++) {
            const cell = rows[r]?.[c]
            row.push(cell === undefined ? null : cell)
          }
          out.push(row)
        }
        return out
      },
    }),
  }
}

// Captures the (blob, filename) pair the exporter would have downloaded.
// The exporter uses URL.createObjectURL → anchor.click() → revokeObjectURL;
// we intercept the createObjectURL + anchor.click pair to record without
// letting the anchor actually navigate.
export interface DownloadCapture {
  calls: { blob: Blob; fileName: string }[]
  uninstall: () => void
}

export function captureDownloads(): DownloadCapture {
  const calls: DownloadCapture['calls'] = []
  const origCreate = URL.createObjectURL
  const origRevoke = URL.revokeObjectURL
  const origCreateElement = document.createElement.bind(document)
  let pendingBlob: Blob | null = null

  URL.createObjectURL = (obj: Blob | MediaSource) => {
    if (obj instanceof Blob) pendingBlob = obj
    return 'blob:fake'
  }
  URL.revokeObjectURL = () => {}

  document.createElement = ((tagName: string, options?: ElementCreationOptions) => {
    const el = origCreateElement(tagName, options)
    if (tagName.toLowerCase() === 'a') {
      ;(el as HTMLAnchorElement).click = () => {
        if (pendingBlob) {
          calls.push({ blob: pendingBlob, fileName: (el as HTMLAnchorElement).download })
          pendingBlob = null
        }
      }
    }
    return el
  }) as typeof document.createElement

  return {
    calls,
    uninstall: () => {
      URL.createObjectURL = origCreate
      URL.revokeObjectURL = origRevoke
      document.createElement = origCreateElement as typeof document.createElement
    },
  }
}

export async function readBlobText(blob: Blob): Promise<string> {
  return new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()))
}

export async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}
