import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fileBasedTabName,
  readAllTabRegistry,
  removeTabRegistry,
  TAB_REGISTRY_PREFIX,
  toTabRegistryEntry,
  writeTabRegistry,
} from './tab-names'

// ---------------------------------------------------------------------------
// fileBasedTabName
// ---------------------------------------------------------------------------

describe('fileBasedTabName', () => {
  beforeEach(() => {
    // 2026-01-18 14:30:05 UTC
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 18, 14, 30, 5))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('strips a single extension and title-cases the stem', () => {
    expect(fileBasedTabName('customers.csv')).toBe('Customers-18-Jan-14-30')
  })

  it('strips only the last extension', () => {
    expect(fileBasedTabName('report.backup.xlsx')).toBe('Report-Backup-18-Jan-14-30')
  })

  it('sanitizes spaces and parens and title-cases each word', () => {
    expect(fileBasedTabName('my report (2024).csv')).toBe('My-Report-2024-18-Jan-14-30')
  })

  it('returns File-… for a dotfile with no stem', () => {
    expect(fileBasedTabName('.csv')).toBe('File-18-Jan-14-30')
  })

  it('returns File-… for a stem that is only special characters', () => {
    expect(fileBasedTabName('---.csv')).toBe('File-18-Jan-14-30')
  })

  it('truncates a very long stem to 40 chars before the suffix', () => {
    const longName = 'a'.repeat(60) + '.csv'
    const result = fileBasedTabName(longName)
    const stem = result.replace(/-18-Jan-14-30$/, '')
    expect(stem.length).toBeLessThanOrEqual(40)
  })

  it('does not leave a trailing hyphen after truncation', () => {
    // Force a truncation that lands right at a word boundary
    const name = ('word'.repeat(11)).slice(0, 44) + '.csv' // stem = 44 chars
    const result = fileBasedTabName(name)
    const stem = result.replace(/-18-Jan-14-30$/, '')
    expect(stem).not.toMatch(/-$/)
  })

  it('uses the correct month abbreviation for each month', () => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    for (let m = 0; m < 12; m++) {
      vi.setSystemTime(new Date(2026, m, 5, 9, 0))
      expect(fileBasedTabName('x.csv')).toBe(`X-05-${months[m]}-09-00`)
    }
  })

  it('pads day, hours, and minutes to two digits', () => {
    vi.setSystemTime(new Date(2026, 0, 5, 9, 3))
    expect(fileBasedTabName('x.csv')).toBe('X-05-Jan-09-03')
  })

  it('handles a filename with no extension', () => {
    expect(fileBasedTabName('nodots')).toBe('Nodots-18-Jan-14-30')
  })

  it('handles digits-only stem', () => {
    expect(fileBasedTabName('2024.csv')).toBe('2024-18-Jan-14-30')
  })
})

// ---------------------------------------------------------------------------
// localStorage registry helpers
// ---------------------------------------------------------------------------

describe('writeTabRegistry / removeTabRegistry / readAllTabRegistry', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('round-trips an entry', () => {
    const entry = { tabId: 'abc-123', name: 'Sheet-0001', lastSeen: 1000 }
    writeTabRegistry(entry)
    const all = readAllTabRegistry()
    expect(all).toHaveLength(1)
    expect(all[0]).toEqual(entry)
  })

  it('removeTabRegistry deletes the entry', () => {
    writeTabRegistry({ tabId: 'abc-123', name: 'Sheet-0001', lastSeen: 1000 })
    removeTabRegistry('abc-123')
    expect(readAllTabRegistry()).toHaveLength(0)
    expect(localStorage.getItem(TAB_REGISTRY_PREFIX + 'abc-123')).toBeNull()
  })

  it('readAllTabRegistry ignores keys that do not start with the prefix', () => {
    localStorage.setItem('unrelated:key', '{"name":"X"}')
    localStorage.setItem('sheet-bro:other', '{"name":"Y"}')
    writeTabRegistry({ tabId: 'tab-1', name: 'Sheet-0001', lastSeen: 1 })
    expect(readAllTabRegistry()).toHaveLength(1)
  })

  it('silently skips malformed JSON entries', () => {
    localStorage.setItem(TAB_REGISTRY_PREFIX + 'bad-id', '{not-valid-json')
    writeTabRegistry({ tabId: 'good-id', name: 'Sheet-0001', lastSeen: 1 })
    const all = readAllTabRegistry()
    expect(all).toHaveLength(1)
    expect(all[0].tabId).toBe('good-id')
  })

  it('returns all entries when multiple tabs are registered', () => {
    writeTabRegistry({ tabId: 'tab-1', name: 'Sheet-0001', lastSeen: 1 })
    writeTabRegistry({ tabId: 'tab-2', name: 'Sheet-0002', lastSeen: 2 })
    writeTabRegistry({ tabId: 'tab-3', name: 'My-File-18-Jan-14-30', lastSeen: 3 })
    expect(readAllTabRegistry()).toHaveLength(3)
  })

  it('overwrites an existing entry with the same tabId', () => {
    writeTabRegistry({ tabId: 'tab-1', name: 'Sheet-0001', lastSeen: 1 })
    writeTabRegistry({ tabId: 'tab-1', name: 'Renamed-18-Jan-14-30', lastSeen: 2 })
    const all = readAllTabRegistry()
    expect(all).toHaveLength(1)
    expect(all[0].name).toBe('Renamed-18-Jan-14-30')
  })

  it('readAllTabRegistry drops entries that fail shape validation', () => {
    // A DevTools user can poke localStorage directly. The shape
    // validator must reject anything that doesn't look like a real
    // TabRegistryEntry, so the UI can't be spoofed from a tampered
    // entry.
    writeTabRegistry({ tabId: 'good-1', name: 'Good-Name', lastSeen: 123 })
    localStorage.setItem(TAB_REGISTRY_PREFIX + 'wrong-shape', JSON.stringify({ tabId: 'wrong-shape' }))
    localStorage.setItem(TAB_REGISTRY_PREFIX + 'mismatch', JSON.stringify({ tabId: 'different', name: 'x', lastSeen: 1 }))
    localStorage.setItem(TAB_REGISTRY_PREFIX + 'bad-types', JSON.stringify({ tabId: 'bad-types', name: 123, lastSeen: 'soon' }))
    const all = readAllTabRegistry()
    expect(all).toHaveLength(1)
    expect(all[0].tabId).toBe('good-1')
  })
})

describe('toTabRegistryEntry', () => {
  const key = TAB_REGISTRY_PREFIX + 'abc'

  it('accepts a well-formed entry', () => {
    expect(toTabRegistryEntry({ tabId: 'abc', name: 'Name', lastSeen: 1 }, key))
      .toEqual({ tabId: 'abc', name: 'Name', lastSeen: 1 })
  })

  it('rejects non-object input', () => {
    expect(toTabRegistryEntry(null, key)).toBeNull()
    expect(toTabRegistryEntry('string', key)).toBeNull()
    expect(toTabRegistryEntry(42, key)).toBeNull()
  })

  it('rejects a tabId that does not match the storage key suffix', () => {
    expect(toTabRegistryEntry({ tabId: 'mismatch', name: 'x', lastSeen: 1 }, key)).toBeNull()
  })

  it('rejects an empty name', () => {
    expect(toTabRegistryEntry({ tabId: 'abc', name: '', lastSeen: 1 }, key)).toBeNull()
  })

  it('rejects a name longer than 256 characters', () => {
    expect(toTabRegistryEntry({ tabId: 'abc', name: 'x'.repeat(257), lastSeen: 1 }, key)).toBeNull()
  })

  it('rejects a non-finite lastSeen', () => {
    expect(toTabRegistryEntry({ tabId: 'abc', name: 'n', lastSeen: NaN }, key)).toBeNull()
    expect(toTabRegistryEntry({ tabId: 'abc', name: 'n', lastSeen: Infinity }, key)).toBeNull()
    expect(toTabRegistryEntry({ tabId: 'abc', name: 'n', lastSeen: '1' }, key)).toBeNull()
  })
})
