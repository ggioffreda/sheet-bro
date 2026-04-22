import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildTableSpec,
  coerceForColumn,
  csvSafe,
  dedupeIdents,
  downloadBlob,
  inferColumnType,
  isHeaderRow,
  quoteIdent,
  sanitizeFilename,
  sanitizeSqlIdent,
  sheetToRowsRaw,
  sqlStringLiteral,
  type SheetData,
} from './shared'

describe('sanitizeSqlIdent', () => {
  it.each([
    ['Sales 2026', 'Sales_2026'],
    ['Q1 / Q2', 'Q1_Q2'],
    ['2026-Q1', '_2026_Q1'],
    ['Café ☕', 'Cafe'],
    ['', 'sheet'],
    ['📊📊', 'sheet'],
    ['order', 'order'], // reserved words survive — always quoted downstream
    ['   ', 'sheet'],
    ['a'.repeat(80), 'a'.repeat(63)], // length cap
    ['__Sales__', 'Sales'],
    ['1foo', '_1foo'],
  ])('sanitizes %j → %j', (input, expected) => {
    expect(sanitizeSqlIdent(input, 'sheet')).toBe(expected)
  })

  it.each([
    ['select'],
    ['group'],
    ['from'],
    ['where'],
    ['table'],
  ])('preserves SQL reserved word %j verbatim (always-quote policy)', (word) => {
    // Pins the "no keyword list, caller always wraps in quotes" contract
    // from CLAUDE.md. A future PR that adds a keyword → alias map must
    // update this test explicitly.
    expect(sanitizeSqlIdent(word, 'fallback')).toBe(word)
  })

  it('truncates a >256-char input cleanly to 63 chars', () => {
    const huge = 'a'.repeat(300)
    expect(sanitizeSqlIdent(huge, 'sheet')).toBe('a'.repeat(63))
    const noisy = `${'b'.repeat(150)}!!!${'c'.repeat(150)}`
    // Underscore replacement runs first, then length cap — result is a
    // single [A-Za-z0-9_]{63} slice.
    const out = sanitizeSqlIdent(noisy, 'sheet')
    expect(out).toHaveLength(63)
    expect(out).toMatch(/^[A-Za-z0-9_]+$/)
  })

  it('prepends underscore to a pure-digit header', () => {
    expect(sanitizeSqlIdent('123', 'fallback')).toBe('_123')
    expect(sanitizeSqlIdent('2026', 'fallback')).toBe('_2026')
  })

  it('strips non-BMP unicode (emoji) down to the ASCII core', () => {
    // NFKD + combining-mark strip + [^A-Za-z0-9_] → underscore +
    // trim-underscore. Emoji have no compatibility decomposition, so the
    // surrogate-pair bytes are replaced as a unit.
    expect(sanitizeSqlIdent('hi🎉', 'fallback')).toBe('hi')
    expect(sanitizeSqlIdent('🎉only', 'fallback')).toBe('only')
  })
})

describe('dedupeIdents', () => {
  it('leaves uniques alone', () => {
    expect(dedupeIdents(['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })
  it('suffixes duplicates with _2, _3, ...', () => {
    expect(dedupeIdents(['x', 'x', 'x'])).toEqual(['x', 'x_2', 'x_3'])
  })
  it('keeps first occurrence naked', () => {
    expect(dedupeIdents(['a', 'b', 'a', 'b', 'a'])).toEqual(['a', 'b', 'a_2', 'b_2', 'a_3'])
  })
})

describe('isHeaderRow', () => {
  it('accepts all-text row', () => {
    expect(isHeaderRow(['id', 'email', 'age'])).toBe(true)
  })
  it('rejects numeric strings', () => {
    expect(isHeaderRow(['1', '2', '3'])).toBe(false)
  })
  it('rejects if any cell is numeric-looking', () => {
    expect(isHeaderRow(['id', '42', 'name'])).toBe(false)
  })
  it('rejects empty cells', () => {
    expect(isHeaderRow(['a', ''])).toBe(false)
  })
  it('rejects JS numbers', () => {
    expect(isHeaderRow(['id', 42 as unknown as string])).toBe(false)
  })
  it('rejects JS booleans', () => {
    expect(isHeaderRow([true as unknown as string])).toBe(false)
  })
  it('rejects empty row', () => {
    expect(isHeaderRow([])).toBe(false)
  })
  it('rejects undefined row', () => {
    expect(isHeaderRow(undefined)).toBe(false)
  })
  it('rejects leading-sign strings', () => {
    expect(isHeaderRow(['+foo'])).toBe(false)
    expect(isHeaderRow(['-bar'])).toBe(false)
  })
})

describe('inferColumnType', () => {
  it.each([
    [[1, 2, 3], 'INTEGER'],
    [['1', '2', '3'], 'INTEGER'],
    [['+99', '-5'], 'INTEGER'],
    [['007'], 'TEXT'], // leading zero → TEXT
    [['0'], 'INTEGER'],
    [[1, 2.5], 'REAL'],
    [['1e3'], 'REAL'],
    [['3.14'], 'REAL'],
    [['1,000'], 'TEXT'], // thousands separator
    [[1, 2, 'abc'], 'TEXT'],
    [[null, null], 'TEXT'],
    [['', null, ''], 'TEXT'],
    [['9007199254740993'], 'TEXT'], // 17 digits → TEXT for precision
    [['9'.repeat(15)], 'INTEGER'], // 15 digits OK
    [[true], 'TEXT'],
    [[Number.NaN], 'TEXT'],
    [[Number.POSITIVE_INFINITY], 'TEXT'],
  ] as const)('infers %j → %s', (cells, expected) => {
    expect(inferColumnType(cells as unknown as (string | number | boolean | null)[])).toBe(expected)
  })
})

describe('coerceForColumn', () => {
  it('INTEGER: string "42" → 42', () => {
    expect(coerceForColumn('42', 'INTEGER')).toBe(42)
  })
  it('INTEGER: null → null', () => {
    expect(coerceForColumn(null, 'INTEGER')).toBeNull()
  })
  it('INTEGER: empty string → null', () => {
    expect(coerceForColumn('', 'INTEGER')).toBeNull()
  })
  it('REAL: string "3.14" → 3.14', () => {
    expect(coerceForColumn('3.14', 'REAL')).toBe(3.14)
  })
  it('TEXT: number 42 → "42"', () => {
    expect(coerceForColumn(42, 'TEXT')).toBe('42')
  })
  it('TEXT: boolean → "TRUE"/"FALSE"', () => {
    expect(coerceForColumn(true, 'TEXT')).toBe('TRUE')
    expect(coerceForColumn(false, 'TEXT')).toBe('FALSE')
  })
  it('INTEGER: Infinity → null', () => {
    expect(coerceForColumn(Number.POSITIVE_INFINITY, 'INTEGER')).toBeNull()
  })
  it('INTEGER: boolean → null (booleans never coerce to a numeric column)', () => {
    expect(coerceForColumn(true, 'INTEGER')).toBeNull()
    expect(coerceForColumn(false, 'REAL')).toBeNull()
  })
  it('INTEGER: unparseable string → null', () => {
    // Regression guard for the NaN fallback branch: a string that Number()
    // can't parse must resolve to null rather than leaking NaN downstream.
    expect(coerceForColumn('not a number', 'INTEGER')).toBeNull()
    expect(coerceForColumn('1.2.3', 'REAL')).toBeNull()
  })
})

describe('inferColumnType — edge cases that classifyCell must handle', () => {
  it('treats a whitespace-only string as null (does not lock the column to TEXT)', () => {
    // After trim, '   ' is empty — classifyCell returns 'null', contributing
    // nothing to the vote. The column of only integers therefore stays INTEGER.
    expect(inferColumnType(['   ', '42', '7'])).toBe('INTEGER')
  })

  it('picks INTEGER when every non-null cell classifies as integer (else-if branch)', () => {
    expect(inferColumnType([null, '1', '2', '3'])).toBe('INTEGER')
  })

  it('picks REAL when a mix of integer and real cells is present', () => {
    expect(inferColumnType(['1', '2.5', '3'])).toBe('REAL')
  })

  it('returns TEXT for an all-null column (neither integer nor real flag set)', () => {
    expect(inferColumnType([null, '', '   '])).toBe('TEXT')
  })
})

describe('uniqueify (via buildTableSpec)', () => {
  it('increments past name_2 when multiple collisions are already taken', () => {
    // Covers the `while (used.has(...)) i += 1` body — three sheets with
    // identical sanitized names must produce distinct table names, not
    // collide on name_2.
    const used = new Set<string>()
    const a = buildTableSpec({ name: 'dup', rows: [['id'], [1]] }, used)!
    const b = buildTableSpec({ name: 'dup', rows: [['id'], [1]] }, used)!
    const c = buildTableSpec({ name: 'dup', rows: [['id'], [1]] }, used)!
    expect(a.tableName).toBe('dup')
    expect(b.tableName).toBe('dup_2')
    expect(c.tableName).toBe('dup_3')
  })
})

describe('sheetToRowsRaw', () => {
  // Minimal ActiveSheet fake — the real Univer API is narrowed to these four
  // methods inside sheetToRowsRaw. Typed as `any` at the seam so the cast
  // mirrors the one the Univer types force on production callers.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  function fake(lastRow: number, lastCol: number, values: any[][]): any {
    return {
      getLastRow: () => lastRow,
      getLastColumn: () => lastCol,
      getRange: () => ({ getValues: () => values }),
    }
  }

  it('returns [] when the sheet has no rows', () => {
    expect(sheetToRowsRaw(fake(-1, -1, []))).toEqual([])
  })

  it('returns [] when the sheet has no columns', () => {
    expect(sheetToRowsRaw(fake(2, -1, []))).toEqual([])
  })

  it('normalizes both null and undefined cell values to null', () => {
    // Regression guard for the `c === null || c === undefined ? null : c`
    // branch. Univer can in principle hand undefined back for sparse ranges;
    // the exporter must fold both into null so downstream formatters get a
    // single sentinel to reason about.
    const rows = sheetToRowsRaw(fake(0, 2, [['a', null, undefined]]))
    expect(rows).toEqual([['a', null, null]])
  })
  /* eslint-enable @typescript-eslint/no-explicit-any */
})

describe('buildTableSpec', () => {
  it('detects header, infers types, and coerces rows', () => {
    const sheet: SheetData = {
      name: 'Sales 2026',
      rows: [
        ['id', 'email', 'amount'],
        ['1', 'a@example.com', '1.5'],
        ['2', 'b@example.com', '2'],
        ['3', 'c@example.com', ''],
      ],
    }
    const spec = buildTableSpec(sheet, new Set())
    expect(spec).not.toBeNull()
    expect(spec!.tableName).toBe('Sales_2026')
    expect(spec!.columns).toEqual([
      { name: 'id', type: 'INTEGER' },
      { name: 'email', type: 'TEXT' },
      { name: 'amount', type: 'REAL' },
    ])
    expect(spec!.rows).toEqual([
      [1, 'a@example.com', 1.5],
      [2, 'b@example.com', 2],
      [3, 'c@example.com', null],
    ])
    expect(spec!.usedGeneratedHeader).toBe(false)
  })

  it('falls back to col1..colN when row 0 is not header-like', () => {
    const sheet: SheetData = {
      name: 'readings',
      rows: [
        ['1', '2.5', 'hot'],
        ['2', '3.1', 'cold'],
      ],
    }
    const spec = buildTableSpec(sheet, new Set())
    expect(spec).not.toBeNull()
    expect(spec!.columns.map((c) => c.name)).toEqual(['col1', 'col2', 'col3'])
    expect(spec!.rows).toHaveLength(2)
    expect(spec!.usedGeneratedHeader).toBe(true)
  })

  it('dedupes table names via the used set', () => {
    const used = new Set<string>()
    const a = buildTableSpec({ name: 'Sales!', rows: [['x'], ['1']] }, used)
    const b = buildTableSpec({ name: 'Sales?', rows: [['y'], ['1']] }, used)
    expect(a!.tableName).toBe('Sales')
    expect(b!.tableName).toBe('Sales_2')
  })

  it('returns null for an empty sheet', () => {
    expect(buildTableSpec({ name: 'x', rows: [] }, new Set())).toBeNull()
    expect(buildTableSpec({ name: 'x', rows: [[null, null]] }, new Set())).toBeNull()
  })

  it('pads short rows with null to match width', () => {
    const sheet: SheetData = {
      name: 'ragged',
      rows: [
        ['a', 'b', 'c'],
        ['1', '2'],
        ['4'],
      ],
    }
    const spec = buildTableSpec(sheet, new Set())!
    expect(spec.rows).toEqual([
      [1, 2, null],
      [4, null, null],
    ])
  })

  it('dedupes duplicate header names', () => {
    const sheet: SheetData = {
      name: 'x',
      rows: [['email', 'email'], ['a', 'b']],
    }
    const spec = buildTableSpec(sheet, new Set())!
    expect(spec.columns.map((c) => c.name)).toEqual(['email', 'email_2'])
  })
})

describe('csvSafe', () => {
  it.each([
    ['=SUM(A1)', "'=SUM(A1)"],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@cmd', "'@cmd"],
    ['\tTAB', "'\tTAB"],
    ['\rCR', "'\rCR"],
    [' =SUM(A1)', "' =SUM(A1)"],
    [' +cmd', "' +cmd"],
    ['  @foo', "'  @foo"],
  ])('prefixes injection trigger %j with single quote', (input, expected) => {
    expect(csvSafe(input)).toBe(expected)
  })

  it.each([
    ['hello', 'hello'],
    ['1+1', '1+1'],
    ['', ''],
  ])('leaves safe string %j untouched', (input, expected) => {
    expect(csvSafe(input)).toBe(expected)
  })

  it('passes through non-strings without modification', () => {
    expect(csvSafe(42)).toBe(42)
    expect(csvSafe(0)).toBe(0)
    expect(csvSafe(true)).toBe(true)
    expect(csvSafe(false)).toBe(false)
    expect(csvSafe(null)).toBeNull()
  })
})

describe('sqlStringLiteral', () => {
  it('wraps an empty string in single quotes', () => {
    expect(sqlStringLiteral('')).toBe("''")
  })
  it('doubles a single embedded quote', () => {
    expect(sqlStringLiteral("it's")).toBe("'it''s'")
  })
  it('doubles every embedded quote', () => {
    expect(sqlStringLiteral("''")).toBe("''''''")
  })
  it('passes through backslash unchanged (SQLite: no backslash escape)', () => {
    expect(sqlStringLiteral('a\\b')).toBe("'a\\b'")
  })
  it('passes through newline and tab unchanged', () => {
    expect(sqlStringLiteral('line1\nline2\ttab')).toBe("'line1\nline2\ttab'")
  })
  it('does not touch double quotes', () => {
    expect(sqlStringLiteral('say "hi"')).toBe("'say \"hi\"'")
  })
})

describe('quoteIdent', () => {
  it('wraps a simple identifier in double quotes', () => {
    expect(quoteIdent('foo')).toBe('"foo"')
  })
  it('escapes an embedded double quote', () => {
    // Defensive — sanitizeSqlIdent usually removes these, but the contract
    // is "always quote + always escape" regardless.
    expect(quoteIdent('a"b')).toBe('"a""b"')
  })
  it('handles reserved word', () => {
    expect(quoteIdent('order')).toBe('"order"')
  })
  it('handles empty string (pathological, but well-defined)', () => {
    expect(quoteIdent('')).toBe('""')
  })
})

describe('sanitizeFilename', () => {
  it.each([
    ['Sales 2026', 'Sales 2026'],
    ['path/to/file', 'path_to_file'],
    ['back\\slash', 'back_slash'],
    ['a:b*c?d', 'a_b_c_d'],
    ['pipe|quote"lt<gt>', 'pipe_quote_lt_gt_'],
    ['wild*card%', 'wild_card_'],
    ['nul\x00here', 'nul_here'],
    ['ctrl\x01\x02\x1f', 'ctrl___'],
  ])('strips %j to %j', (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected)
  })

  it('trims surrounding whitespace', () => {
    expect(sanitizeFilename('   spaced   ')).toBe('spaced')
  })

  it('falls back when result is empty', () => {
    expect(sanitizeFilename('')).toBe('sheet')
    expect(sanitizeFilename('   ')).toBe('sheet')
    expect(sanitizeFilename('', 'workbook')).toBe('workbook')
  })

  it('caps at 100 characters', () => {
    const long = 'a'.repeat(150)
    expect(sanitizeFilename(long)).toHaveLength(100)
  })

  it('unicode (non-path-special) is preserved', () => {
    expect(sanitizeFilename('Café ☕')).toBe('Café ☕')
  })

  it.each([
    ['CON', '_CON'],
    ['con', '_con'],
    ['PRN', '_PRN'],
    ['AUX', '_AUX'],
    ['NUL', '_NUL'],
    ['COM1', '_COM1'],
    ['COM9', '_COM9'],
    ['LPT1', '_LPT1'],
    ['LPT9', '_LPT9'],
    ['CON.txt', '_CON.txt'],
    ['prn.log', '_prn.log'],
  ])('prefixes Windows reserved name %j → %j', (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected)
  })

  it('does not prefix names that merely contain reserved tokens', () => {
    expect(sanitizeFilename('CONSOLE')).toBe('CONSOLE')
    expect(sanitizeFilename('COM10')).toBe('COM10')
    expect(sanitizeFilename('LPT0')).toBe('LPT0')
    expect(sanitizeFilename('MYPRN')).toBe('MYPRN')
  })
})

describe('downloadBlob', () => {
  // Install deterministic fakes for the browser-only APIs so we can verify
  // the deferred-revoke behaviour without actually waiting 60 s.
  let created: string[] = []
  let revoked: string[] = []
  let clicked: string[] = []
  let origCreate: typeof URL.createObjectURL
  let origRevoke: typeof URL.revokeObjectURL
  let origCreateElement: typeof document.createElement

  beforeEach(() => {
    created = []
    revoked = []
    clicked = []
    origCreate = URL.createObjectURL
    origRevoke = URL.revokeObjectURL
    origCreateElement = document.createElement.bind(document)
    let seq = 0
    URL.createObjectURL = () => {
      const u = `blob:test-${++seq}`
      created.push(u)
      return u
    }
    URL.revokeObjectURL = (u: string) => { revoked.push(u) }
    document.createElement = ((tag: string, opts?: ElementCreationOptions) => {
      const el = origCreateElement(tag, opts)
      if (tag.toLowerCase() === 'a') {
        (el as HTMLAnchorElement).click = () => { clicked.push((el as HTMLAnchorElement).href) }
      }
      return el
    }) as typeof document.createElement
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    URL.createObjectURL = origCreate
    URL.revokeObjectURL = origRevoke
    document.createElement = origCreateElement as typeof document.createElement
  })

  it('creates a blob URL, clicks the anchor, and defers revoke by ~60s', () => {
    downloadBlob(new Blob(['hello']), 'out.txt')
    expect(created).toHaveLength(1)
    expect(clicked).toEqual(created)
    // Synchronously after the call the URL must still be alive — otherwise
    // the browser may abort the download.
    expect(revoked).toEqual([])
    vi.advanceTimersByTime(59_000)
    expect(revoked).toEqual([])
    vi.advanceTimersByTime(2_000)
    expect(revoked).toEqual(created)
  })
})
