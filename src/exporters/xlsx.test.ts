import { beforeEach, describe, expect, it, vi } from 'vitest'

const { writeMock } = vi.hoisted(() => ({
  // Returns a Blob when `fileName` is omitted (buildXlsxExport path), undefined
  // otherwise (exportXlsx download path — it triggers a download via fileName).
  writeMock: vi.fn((_data: unknown, options?: { fileName?: string }) =>
    options?.fileName ? Promise.resolve(undefined) : Promise.resolve(new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })),
  ),
}))
vi.mock('write-excel-file/browser', () => ({ default: writeMock }))

import { buildXlsxExport, buildXlsxPlan, exportXlsx } from './xlsx'
import { buildFakeUniverAPI } from '../test-helpers/fake-univer'

describe('buildXlsxPlan', () => {
  it('extracts sheet names and csvSafe-ed row data in sheet order', () => {
    const api = buildFakeUniverAPI([
      { name: 'First', rows: [['a'], [1]] },
      { name: 'Second', rows: [['=bad'], ['+1']] },
    ])
    const wb = api.getActiveWorkbook()!
    const plan = buildXlsxPlan(wb)
    expect(plan.sheetNames).toEqual(['First', 'Second'])
    expect(plan.sheetDatas).toHaveLength(2)
    expect(plan.sheetDatas[1][0]).toEqual(["'=bad"])
    expect(plan.sheetDatas[1][1]).toEqual(["'+1"])
  })

  it('substitutes "SheetN" for sheets with blank names', () => {
    const api = buildFakeUniverAPI([
      { name: '', rows: [['x']] },
      { name: '', rows: [['y']] },
    ])
    const plan = buildXlsxPlan(api.getActiveWorkbook()!)
    expect(plan.sheetNames).toEqual(['Sheet1', 'Sheet2'])
  })

  it('returns empty plan for a workbook with no sheets', () => {
    const api = buildFakeUniverAPI([])
    const plan = buildXlsxPlan(api.getActiveWorkbook()!)
    expect(plan).toEqual({ sheetNames: [], sheetDatas: [] })
  })
})

describe('exportXlsx (wrapper)', () => {
  beforeEach(() => writeMock.mockClear())

  it('calls writeXlsxFile with { sheet: name } for a single-sheet workbook', async () => {
    const api = buildFakeUniverAPI([
      { name: 'Only', rows: [['x'], [1]] },
    ])
    await exportXlsx(api)
    expect(writeMock).toHaveBeenCalledTimes(1)
    const [data, options] = writeMock.mock.calls[0]
    expect(options).toEqual({ fileName: 'workbook.xlsx', sheet: 'Only' })
    expect(data).toEqual([['x'], [1]])
  })

  it('calls writeXlsxFile with { sheets: names } for a multi-sheet workbook', async () => {
    const api = buildFakeUniverAPI([
      { name: 'A', rows: [[1]] },
      { name: 'B', rows: [[2]] },
    ])
    await exportXlsx(api)
    const [data, options] = writeMock.mock.calls[0]
    expect(options).toEqual({ fileName: 'workbook.xlsx', sheets: ['A', 'B'] })
    expect(data).toEqual([[[1]], [[2]]])
  })

  it('is a no-op when there is no active workbook', async () => {
    await exportXlsx(buildFakeUniverAPI(null))
    expect(writeMock).not.toHaveBeenCalled()
  })

  it('is a no-op when the workbook has zero sheets', async () => {
    await exportXlsx(buildFakeUniverAPI([]))
    expect(writeMock).not.toHaveBeenCalled()
  })
})

describe('buildXlsxExport', () => {
  beforeEach(() => writeMock.mockClear())

  it('returns bytes + filename for a single-sheet workbook (no fileName passed to writer)', async () => {
    const api = buildFakeUniverAPI([
      { name: 'Only', rows: [['x'], [1]] },
    ])
    const result = await buildXlsxExport(api)
    expect(result).not.toBeNull()
    expect(result!.filename).toBe('workbook.xlsx')
    expect(result!.bytes).toBeInstanceOf(Uint8Array)
    const [, options] = writeMock.mock.calls[0]
    expect(options).toEqual({ sheet: 'Only' })
  })

  it('uses stem for filename and sheets option for multi-sheet workbook', async () => {
    const api = buildFakeUniverAPI([
      { name: 'A', rows: [[1]] },
      { name: 'B', rows: [[2]] },
    ])
    const result = await buildXlsxExport(api, 'custom')
    expect(result!.filename).toBe('custom.xlsx')
    const [, options] = writeMock.mock.calls[0]
    expect(options).toEqual({ sheets: ['A', 'B'] })
  })

  it('returns null when there is no active workbook', async () => {
    expect(await buildXlsxExport(buildFakeUniverAPI(null))).toBeNull()
  })

  it('returns null when the workbook has zero sheets', async () => {
    expect(await buildXlsxExport(buildFakeUniverAPI([]))).toBeNull()
  })
})
