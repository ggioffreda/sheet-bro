# Architecture

## File map

```
index.html                       # Static DOM (#grid, #empty-state,
                                 # #drag-overlay, #notify, #progress-bar,
                                 # #password-dialog, #confirm-dialog,
                                 # .app-logo) AND all critical CSS inline
                                 # in <style>. Inline so it applies during
                                 # the initial paint — prevents FOUC of
                                 # the empty-state text and layout. A
                                 # defense-in-depth CSP <meta> also ships
                                 # here — see docs/security.md.
src/
├── main.ts                      # Entry: calls initApp().
├── app.ts                       # Lifecycle + DOM: Univer setup, drop
│                                # handling, ribbon menu registration,
│                                # persistence wiring, tab naming,
│                                # password / confirm modals, empty-state
│                                # / drag-overlay / notify toggling. File
│                                # dispatch is delegated to file-router;
│                                # import and export live under
│                                # ./importers/ and ./exporters/.
├── file-router.ts               # detectFileKind / importerForKind /
│                                # labelForKind — magic-byte sniffing
│                                # with extension fallback.
├── cell.ts                      # normalizeCell: importer CellPrimitive
│                                # → Univer string|number.
├── workbook-shape.ts            # buildWorkbookShape: pure LoadedSheet[]
│                                # → Univer workbook-snapshot shape.
├── snapshot-shape.ts            # isPersistedSnapshot: minimal gate
│                                # before feeding a stored record to
│                                # univerAPI.createWorkbook.
├── tab-names.ts                 # Cross-tab registry via localStorage
│                                # (key prefix `sheet-bro:tab:`) plus
│                                # `fileBasedTabName(filename)`. See
│                                # docs/persistence.md.
├── user-facing-error.ts         # `UserFacingError` + `toUserMessage` —
│                                # error-message gating. See
│                                # docs/security.md.
├── sqljs.ts                     # Shared lazy loader for sql.js used by
│                                # both import and export paths.
├── persistence.ts               # IndexedDB + WebCrypto persistence
│                                # layer. See docs/persistence.md.
├── sw-register.ts               # PWA service worker registration.
│                                # Registers /sw.js in production only,
│                                # handles update toasts.
├── launch-queue.ts              # PWA File Handling API. Lets the
│                                # installed desktop PWA open
│                                # CSV/XLSX/SQLite/SQL files from the OS.
├── test-helpers/fake-univer.ts  # Minimal stand-in for univerAPI used
│                                # by exporter unit tests.
├── importers/                   # File → LoadedSheet[] pipeline.
│   ├── csv.ts / xlsx.ts / sql.ts / sql-dialect.ts / index.ts
│   ├── *.test.ts / fixtures/*.sql
├── exporters/                   # Workbook → file pipeline.
│   ├── shared.ts                # Sanitizers, header detection, type
│   │                            # inference, TableSpec. See
│   │                            # docs/exporters.md.
│   ├── csv.ts / xlsx.ts / sql.ts / sqlite.ts / index.ts
│   ├── safe-export.ts           # Password-encrypted ZIP wrapper around
│   │                            # each of the four formats. See
│   │                            # docs/exporters.md.
│   └── *.test.ts
└── *.test.ts                    # Top-level tests for cell, file-router,
                                 # launch-queue, persistence,
                                 # snapshot-shape, sqljs, sw-register,
                                 # tab-names, user-facing-error,
                                 # workbook-shape.
```

## Lifecycle

1. `main.ts` runs at module-eval time and calls `initApp()`.
2. `initApp()` queries the static elements from `index.html`
   (`#csv-spreadsheet`, `#grid`, `#empty-state`, `#drag-overlay`,
   `#notify`, `#progress-bar`, `#password-dialog`, `#confirm-dialog`),
   wires drag/drop and cross-tab listeners, then awaits `initStorage()`
   which opens IndexedDB, prunes 24h-old records, and ensures a tab
   UUID + AES key in `sessionStorage`.
3. Tab name is resolved (`initTabName`), written to
   `document.title` and to the cross-tab `localStorage` registry
   (`sheet-bro:tab:<uuid>`). Other tabs' entries are read into the
   in-memory `openTabRegistry` (`app.ts:128-140`). See
   `docs/persistence.md`.
4. If a record exists for this tab it's decrypted, shape-checked by
   `isPersistedSnapshot`, and passed to
   `univerAPI.createWorkbook(snapshot)`; the empty-state overlay is
   hidden. Otherwise an empty workbook is created. If decryption or
   `createWorkbook` throws, a sticky toast via `notify()` explains
   the fall-back and the command listener is **not** attached —
   see step 5.
5. A debounced (400 ms) listener on `univerAPI.Event.CommandExecuted`
   re-encrypts and writes the current snapshot back. This listener
   is suppressed when step 4 found an unreadable record, so the empty
   fallback workbook's internal commands don't overwrite the still-
   encrypted data. Dropping a new file re-arms the listener inside
   `loadIntoWorkbook` — an explicit user overwrite (`app.ts:732-737`).
6. `registerFileMenu` builds the File ribbon (Export, Safe Export,
   Clean Up submenus). See `docs/ribbon.md`.
7. Under `VITE_E2E`, `initApp` exposes
   `window.__sheetbro = { univerAPI, setHasData, persistNow,
   readTabRegistry, getTabId }` for Playwright drive-through
   (`app.ts:191-199`). The branch is guarded by `import.meta.env.VITE_E2E`,
   which Vite inlines at build time, so production bundles compile it
   out entirely. Under `VITE_E2E` a `?importTimeoutMs=N` query param
   also overrides the import timeout so Playwright can exercise the
   guard in a few hundred ms.
8. After Univer is up, the next animation frame adds `is-ready` to
   `#csv-spreadsheet`, which transitions its `opacity` from 0 to 1
   over 250 ms. A 30 s `setTimeout` adds `is-faded` to `#empty-state`,
   fading the "Drop a CSV…" hint over 1.5 s.
9. Drop handler: `runImport(file)` detects the kind, reads bytes under
   a timeout guard (`IMPORT_TIMEOUT_MS`, default 30 s), parses, and
   calls `loadIntoWorkbook`, which names the tab after the file
   (`fileBasedTabName`), writes to the registry, and updates
   `document.title` (`app.ts:718-753`).
10. Clean Up actions — `cleanupThisTab` / `cleanupAllTabs` — delete
    records and tab identity, show the in-app confirm modal first
    (`promptConfirm`, which replaced `window.confirm`). "All Tabs"
    also broadcasts `{type:'clear-all'}` on
    `BroadcastChannel('sheet-bro-events')` so other open tabs reset
    themselves (`app.ts:519-552`).
11. `window.beforeunload` invokes `teardown()` which removes cross-tab
    listeners, drops this tab's registry entry, disposes the command
    listener, closes the DB, and disposes Univer.

## UI state

UI state lives entirely in DOM attributes — no reactivity framework:

- `#empty-state[hidden]` / `#drag-overlay[hidden]` — show/hide via
  `setHasData` / `setDragActive`.
- `.csv-spreadsheet.is-ready` — initial fade-in.
- `.empty-state.is-faded` — 30-second fade-out.
- `#notify[hidden]` — toast element. `notify(message, sticky?)` in
  `app.ts`. Pass `sticky: true` for errors that need reading;
  default auto-dismisses after 5 s.
- `#progress-bar[hidden]` — import progress, exponential-decay fill
  (`startTimeFill`).
- `#password-dialog[hidden]` / `#confirm-dialog[hidden]` — modals
  surfaced by `promptPassword` / `promptConfirm`.

The `[hidden] { display: none !important }` rule in `index.html` is
load-bearing — without `!important` the class-level `display: flex`
rules beat the user-agent stylesheet's `[hidden]` rule (equal
specificity, author wins) and the overlays stay visible.

## When `app.ts` keeps growing

Imports and exports live under `src/importers/` and `src/exporters/`;
file-kind dispatch is in `src/file-router.ts`; the normalize/shape
seams are in `src/cell.ts` and `src/workbook-shape.ts`; the cross-tab
registry is in `src/tab-names.ts`; error gating is in
`src/user-facing-error.ts`. `app.ts` is down to: lifecycle
(init/teardown), Univer setup, drag/drop wiring, ribbon menu
registration, persistence wiring, command listener, password/confirm
modals, cross-tab listeners, and overlay toggling.

If you're adding more non-trivial behavior, the ribbon-menu
registration (`registerFileMenu` plus the `runExport` /
`runSafeExport` wrappers) and the modal wiring
(`promptPassword` / `promptConfirm`) are plausible extraction targets.
