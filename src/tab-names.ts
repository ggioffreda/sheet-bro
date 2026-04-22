export const TAB_REGISTRY_PREFIX = 'sheet-bro:tab:'

export interface TabRegistryEntry {
  tabId: string   // = the IndexedDB key for this tab's workbook record
  name: string
  lastSeen: number
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function fileBasedTabName(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, '')
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const suffix = `${pad(now.getDate())}-${MONTHS[now.getMonth()]}-${pad(now.getHours())}-${pad(now.getMinutes())}`
  const parts = stem
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
  const safeStem = parts.join('-').slice(0, 40).replace(/-+$/, '')
  return `${safeStem || 'File'}-${suffix}`
}

export function writeTabRegistry(entry: TabRegistryEntry): void {
  localStorage.setItem(TAB_REGISTRY_PREFIX + entry.tabId, JSON.stringify(entry))
}

export function removeTabRegistry(tabId: string): void {
  localStorage.removeItem(TAB_REGISTRY_PREFIX + tabId)
}

export function readAllTabRegistry(): TabRegistryEntry[] {
  const result: TabRegistryEntry[] = []
  for (let i = 0; i < localStorage.length; i++) {
    /* v8 ignore start */
    const key = localStorage.key(i)
    if (!key?.startsWith(TAB_REGISTRY_PREFIX)) continue
    const raw = localStorage.getItem(key) ?? ''
    /* v8 ignore stop */
    try {
      const parsed: unknown = JSON.parse(raw)
      const entry = toTabRegistryEntry(parsed, key)
      if (entry) result.push(entry)
    } catch {
      // skip malformed entries
    }
  }
  return result
}

// Validate an untrusted localStorage payload before trusting its fields.
// The value is written only by same-origin code, but a user (or malicious
// page sharing the origin in a hosted deployment) can poke localStorage
// directly from DevTools — guard every field type and cap `name` length
// so a spoofed entry cannot stretch the cleanup-all dialog or store a
// wildly wrong `lastSeen` that would defeat the liveness sweep.
export function toTabRegistryEntry(v: unknown, storageKey: string): TabRegistryEntry | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.tabId !== 'string' || o.tabId !== storageKey.slice(TAB_REGISTRY_PREFIX.length)) return null
  if (typeof o.name !== 'string' || o.name.length === 0 || o.name.length > 256) return null
  if (typeof o.lastSeen !== 'number' || !Number.isFinite(o.lastSeen)) return null
  return { tabId: o.tabId, name: o.name, lastSeen: o.lastSeen }
}
