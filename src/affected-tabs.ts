import type { TabRegistryEntry } from './tab-names'

export const MAX_TABS_IN_CONFIRM = 8

/**
 * Merge the persisted tab registry with the caller-supplied current-tab info,
 * sorted newest-first by lastSeen. The current tab is always included (even if
 * it hasn't been written to localStorage yet, e.g. before the first persist).
 */
export function collectAffectedTabs(
  registry: TabRegistryEntry[],
  current: { tabId: string; name: string } | null,
  now: number = Date.now(),
): TabRegistryEntry[] {
  const byId = new Map<string, TabRegistryEntry>()
  for (const entry of registry) byId.set(entry.tabId, entry)
  if (current && !byId.has(current.tabId)) {
    byId.set(current.tabId, { tabId: current.tabId, name: current.name, lastSeen: now })
  }
  return [...byId.values()].sort((a, b) => b.lastSeen - a.lastSeen)
}

/**
 * Display labels for the confirm dialog's bulleted list. Truncates to
 * MAX_TABS_IN_CONFIRM entries, appending "+N more…" as the final item when
 * the list exceeds the cap. Blank names become "(unnamed tab)".
 */
export function buildAffectedTabLabels(entries: TabRegistryEntry[]): string[] {
  if (entries.length === 0) return []
  const nameOf = (e: TabRegistryEntry) => e.name.trim() || '(unnamed tab)'
  if (entries.length <= MAX_TABS_IN_CONFIRM) return entries.map(nameOf)
  const shown = entries.slice(0, MAX_TABS_IN_CONFIRM - 1).map(nameOf)
  const remaining = entries.length - shown.length
  shown.push(`+${remaining} more…`)
  return shown
}
