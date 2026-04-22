// Minimal shape gate for persisted workbook snapshots. Rejects the
// obviously-wrong cases (null, primitives, arrays) so Univer never sees
// garbage under the unsafe `as IWorkbookData` cast. Anything else — even
// if the inner fields drift between Univer versions — flows through to
// `createWorkbook`, which is wrapped in try/catch by the caller. A
// stricter check here caused false rejections when Univer's save shape
// evolved mid-session, overwriting the user's encrypted record with an
// empty workbook on the next load.
export function isPersistedSnapshot(x: unknown): boolean {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}
