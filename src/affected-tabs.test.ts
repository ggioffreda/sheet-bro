import { describe, expect, it } from 'vitest'
import { buildAffectedTabLabels, collectAffectedTabs, MAX_TABS_IN_CONFIRM } from './affected-tabs'
import type { TabRegistryEntry } from './tab-names'

function entry(tabId: string, name: string, lastSeen: number): TabRegistryEntry {
  return { tabId, name, lastSeen }
}

describe('collectAffectedTabs', () => {
  it('returns empty array when registry empty and no current tab', () => {
    expect(collectAffectedTabs([], null)).toEqual([])
  })

  it('sorts registry entries by lastSeen descending', () => {
    const out = collectAffectedTabs(
      [entry('a', 'Alpha', 100), entry('b', 'Bravo', 300), entry('c', 'Charlie', 200)],
      null,
    )
    expect(out.map((e) => e.tabId)).toEqual(['b', 'c', 'a'])
  })

  it('adds the current tab when it is missing from the registry', () => {
    const out = collectAffectedTabs([entry('a', 'Alpha', 100)], { tabId: 'cur', name: 'Current' }, 500)
    expect(out[0]).toMatchObject({ tabId: 'cur', name: 'Current', lastSeen: 500 })
    expect(out.map((e) => e.tabId)).toEqual(['cur', 'a'])
  })

  it('does not duplicate the current tab when it is already registered', () => {
    const out = collectAffectedTabs(
      [entry('cur', 'Stored', 100), entry('a', 'Alpha', 50)],
      { tabId: 'cur', name: 'InMemory' },
      999,
    )
    expect(out.filter((e) => e.tabId === 'cur')).toHaveLength(1)
    expect(out.find((e) => e.tabId === 'cur')?.name).toBe('Stored')
  })

  it('ignores the current tab argument when null', () => {
    const out = collectAffectedTabs([entry('a', 'Alpha', 100)], null)
    expect(out.map((e) => e.tabId)).toEqual(['a'])
  })
})

describe('buildAffectedTabLabels', () => {
  it('returns [] for empty input', () => {
    expect(buildAffectedTabLabels([])).toEqual([])
  })

  it('returns all names when at or below the cap', () => {
    const entries = Array.from({ length: MAX_TABS_IN_CONFIRM }, (_, i) => entry(`t${i}`, `Tab ${i}`, i))
    expect(buildAffectedTabLabels(entries)).toEqual(entries.map((e) => e.name))
  })

  it('truncates to MAX-1 names and appends "+N more…" when over the cap', () => {
    const entries = Array.from({ length: MAX_TABS_IN_CONFIRM + 4 }, (_, i) => entry(`t${i}`, `Tab ${i}`, i))
    const out = buildAffectedTabLabels(entries)
    expect(out).toHaveLength(MAX_TABS_IN_CONFIRM)
    expect(out.slice(0, MAX_TABS_IN_CONFIRM - 1)).toEqual(
      entries.slice(0, MAX_TABS_IN_CONFIRM - 1).map((e) => e.name),
    )
    expect(out[out.length - 1]).toBe('+5 more…')
  })

  it('produces exactly "+2 more…" when list exceeds cap by 1', () => {
    const entries = Array.from({ length: MAX_TABS_IN_CONFIRM + 1 }, (_, i) => entry(`t${i}`, `Tab ${i}`, i))
    const out = buildAffectedTabLabels(entries)
    expect(out[out.length - 1]).toBe('+2 more…')
  })

  it('falls back to "(unnamed tab)" for blank or whitespace names', () => {
    const out = buildAffectedTabLabels([entry('a', '', 1), entry('b', '   ', 2), entry('c', 'Named', 3)])
    expect(out).toEqual(['(unnamed tab)', '(unnamed tab)', 'Named'])
  })
})
