# Persistence

## Encrypted IndexedDB per tab

- AES-GCM-256, raw-bytes key export → base64 in `sessionStorage`.
- Per-save random 12-byte IV (96 bits — standard for GCM).
- Record shape:
  `{ iv: Uint8Array, ciphertext: ArrayBuffer, lastSeen: number }`,
  stored directly via IndexedDB structured clone (no JSON wrapping
  needed inside the record itself).
- TTL prune: 24 h (`MAX_AGE_MS` in `src/persistence.ts`), run at
  `initStorage`.
- Quota errors: caught and surface via `notify(..., sticky=true)`.
  No automatic fallback — user sees
  "Workbook too large to save — your changes will not persist."
  (`app.ts:597-601`).

### WebCrypto requires HTTPS in production

`crypto.subtle` is disabled on plain HTTP for everything except
`localhost`. If a user reports "my data didn't persist", the first
question is "are you on HTTPS?" — not a bug in our code.

## Cross-tab registry via localStorage

`src/tab-names.ts` maintains a parallel registry in `localStorage`
keyed by `sheet-bro:tab:<uuid>`:

```ts
interface TabRegistryEntry {
  tabId: string   // = the IndexedDB key for this tab's workbook record
  name: string
  lastSeen: number
}
```

`writeTabRegistry`, `removeTabRegistry`, `readAllTabRegistry` and the
`fileBasedTabName(filename)` helper (which produces e.g.
`Sales-Q1-18-Apr-14-23`) live in this module.

### Why localStorage (not BroadcastChannel)

The registry needs to be **persistent** so a tab that opens *after*
other tabs already exist can read their names on startup.
`BroadcastChannel` is ephemeral — it only delivers messages to
listeners that were present when the message was sent, which would
leave latecoming tabs with an empty tab list.

`BroadcastChannel('sheet-bro-events')` is still used for one-shot
action notifications (`{type:'clear-all'}` when a user clicks Clean
Up → All Tabs; `app.ts:545 / 549-553`).

### Live updates across tabs

`app.ts:555-568` listens for `window.storage` events. When another
tab writes a registry entry, the local `openTabRegistry` Map
updates; when another tab removes one, the entry is deleted. This
keeps the in-memory view of open tabs fresh without polling.

### Lifecycle touchpoints

- **`initApp`** — writes own entry, reads all others
  (`app.ts:131-134`).
- **`loadIntoWorkbook`** — on file drop, updates own entry with the
  file-based name and refreshes `document.title`
  (`app.ts:740-748`).
- **`persistWorkbook`** — refreshes `lastSeen` on every debounced
  save so stale entries can eventually be pruned
  (`app.ts:604-605`).
- **`teardown`** — removes own entry on `beforeunload`
  (`app.ts:573`).
- **`cleanupAllTabs`** — removes every `sheet-bro:tab:*` entry
  (`app.ts:544`).

## Threat model notes

- Same-origin other tabs **can** read `sheet-bro:tab:*` (it's
  `localStorage`). This is intentional — they need the names to
  render the list. It does **not** leak workbook content; it only
  leaks filenames.
- `sessionStorage` is tab-local; closing a tab destroys the AES key,
  leaving the encrypted IndexedDB record cryptographically inert
  until the TTL pruner clears it.
- Tab duplication (Chrome/Firefox "Duplicate Tab") copies
  `sessionStorage` **and** therefore the key — the duplicate sees
  the same data. README covers this.
