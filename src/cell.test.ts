import { describe, expect, it } from 'vitest'
import { normalizeCell } from './cell'

describe('normalizeCell', () => {
  it('returns the string unchanged', () => {
    expect(normalizeCell('hello')).toBe('hello')
    expect(normalizeCell('')).toBe('')
  })

  it('returns the number unchanged', () => {
    expect(normalizeCell(42)).toBe(42)
    expect(normalizeCell(0)).toBe(0)
    expect(normalizeCell(-3.14)).toBe(-3.14)
  })

  it('maps booleans to TRUE / FALSE (symmetric with exporter coercion)', () => {
    expect(normalizeCell(true)).toBe('TRUE')
    expect(normalizeCell(false)).toBe('FALSE')
  })

  it('maps null and undefined to empty string', () => {
    expect(normalizeCell(null)).toBe('')
    expect(normalizeCell(undefined as unknown as null)).toBe('')
  })

  it('maps Date to ISO-8601', () => {
    const d = new Date(Date.UTC(2026, 0, 15, 9, 30, 0))
    expect(normalizeCell(d)).toBe('2026-01-15T09:30:00.000Z')
  })

  it('represents Uint8Array as a size tag rather than inlining bytes', () => {
    expect(normalizeCell(new Uint8Array(0))).toBe('[BLOB: 0 bytes]')
    expect(normalizeCell(new Uint8Array(5))).toBe('[BLOB: 5 bytes]')
    expect(normalizeCell(new Uint8Array(1_048_576))).toBe('[BLOB: 1048576 bytes]')
  })

  it('does not treat "0" / "" strings as falsy (and keeps them as strings)', () => {
    const zero = normalizeCell('0')
    expect(zero).toBe('0')
    expect(typeof zero).toBe('string')

    const empty = normalizeCell('')
    expect(empty).toBe('')
    expect(typeof empty).toBe('string')

    const falseStr = normalizeCell('false')
    expect(falseStr).toBe('false')
    expect(typeof falseStr).toBe('string')
  })

  it('preserves NaN and Infinity as-is (typing contract: number in → number out)', () => {
    expect(Number.isNaN(normalizeCell(Number.NaN) as number)).toBe(true)
    expect(normalizeCell(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
  })
})
