import type { LoadedSheet } from './index'

export async function importCsv(file: File): Promise<LoadedSheet[]> {
  return parseCsvText(await file.text())
}

export async function parseCsvText(text: string): Promise<LoadedSheet[]> {
  const { default: Papa } = await import('papaparse')
  return new Promise((resolve, reject) => {
    Papa.parse<string[]>(text, {
      skipEmptyLines: true,
      complete: (results) => {
        const rows = results.data.map((row) => row.map(coerceCsvCell))
        resolve([{ name: 'Sheet1', rows }])
      },
      error: (err: Error) => reject(err),
    })
  })
}

function coerceCsvCell(cell: string): string | number {
  if (cell === '') return cell
  const num = Number(cell)
  return Number.isNaN(num) ? cell : num
}
