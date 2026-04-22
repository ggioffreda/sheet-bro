// The gate is permissive by design. See src/snapshot-shape.ts and CLAUDE.md
// lifecycle step 3: a stricter check overwrote users' encrypted records when
// Univer's internal save shape drifted between versions. These tests pin the
// permissive contract so a future "hardening" PR that tightens the guard
// (e.g. rejecting wrong-typed inner fields) fails here and has to be an
// explicit, informed decision — not a silent regression.
import { describe, expect, it } from 'vitest'
import { isPersistedSnapshot } from './snapshot-shape'

describe('isPersistedSnapshot', () => {
  it('accepts a plain object', () => {
    expect(isPersistedSnapshot({})).toBe(true)
    expect(isPersistedSnapshot({ sheets: {}, sheetOrder: [] })).toBe(true)
    expect(isPersistedSnapshot({ anything: 123 })).toBe(true)
  })

  it('accepts objects with wrong-typed inner fields (forward-compat pin)', () => {
    expect(isPersistedSnapshot({ sheets: 'not-an-object' })).toBe(true)
    expect(isPersistedSnapshot({ sheets: {}, sheetOrder: 'not-an-array' })).toBe(true)
    expect(isPersistedSnapshot({ sheetOrder: 42 })).toBe(true)
    expect(isPersistedSnapshot({ __env__: null })).toBe(true)
  })

  it('accepts objects missing any of the known fields', () => {
    expect(isPersistedSnapshot({ unknownField: 42 })).toBe(true)
    expect(isPersistedSnapshot({ id: undefined })).toBe(true)
  })

  it('rejects null', () => {
    expect(isPersistedSnapshot(null)).toBe(false)
  })

  it('rejects primitives', () => {
    expect(isPersistedSnapshot(42)).toBe(false)
    expect(isPersistedSnapshot('snapshot')).toBe(false)
    expect(isPersistedSnapshot(true)).toBe(false)
    expect(isPersistedSnapshot(undefined)).toBe(false)
  })

  it('rejects arrays (not a valid workbook shape even though typeof === object)', () => {
    expect(isPersistedSnapshot([])).toBe(false)
    expect(isPersistedSnapshot([{ sheets: {} }])).toBe(false)
  })
})
