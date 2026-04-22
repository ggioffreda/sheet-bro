# CLAUDE.md

Guidance for Claude Code working in this repo. Start here; deep
material lives in `docs/`.

## What this is

sheet-bro is a browser-only spreadsheet built on **vanilla TypeScript**
+ Vite + Univer (no UI framework). Users drop CSV, XLSX, SQLite DB,
or SQL dump files onto the page; the app opens them in a Univer
workbook with formulas, filters, and export. Data persists per-tab
in IndexedDB, encrypted with an AES-GCM key held in `sessionStorage`.
There is no backend. See `README.md` for the user-facing description.

## Commands

```bash
pnpm install                       # install deps
pnpm dev                           # Vite dev server with HMR
pnpm typecheck                     # tsc -b — type-check only, no bundling
pnpm test                          # vitest run — unit tests
pnpm test:coverage                 # vitest run --coverage
pnpm test:e2e                      # Playwright end-to-end suite
pnpm test:all                      # typecheck + coverage + e2e
pnpm build                         # tsc -b + vite build → dist/
pnpm preview                       # serve built dist/
pnpm audit --audit-level low       # dep vulnerability check
```

`pnpm build` requires Node ≥ 20.19 (Vite 7 constraint). The Node
engine declared in `package.json` is 24.14.1; Node 20.11.x will
type-check fine but fails at the Vite step. Don't treat that failure
as a code regression — check the Node version first.

## Hard rules

- **Pin every direct dep to an exact version.** No `^`, no `~`. No
  packages published <7 days ago. Run `pnpm audit --audit-level low`
  after every `pnpm add`. Details: `docs/dependencies.md`.
- **`.npmrc` has `ignore-scripts=true`.** Intentional and
  load-bearing. If a dep legitimately needs a postinstall, use a
  narrow `pnpm.onlyBuiltDependencies` allowlist — don't flip the
  flag. Details: `docs/security.md`.
- **No `eval` / `unsafe-eval`.** Hard stop for any dep that
  requires it. CSP in `index.html` enforces this.
- **Exporters stay Univer-agnostic in their pure parts.**
  `buildSqlText` / `buildDbBytes` / `buildCsvExport` /
  `buildXlsxExport` take plain data. Only the top-level wrappers
  touch `univerAPI`. Breaking this breaks `sql.test.ts`'s direct
  round-trip. Details: `docs/exporters.md`.
- **`UserFacingError` is the only error class whose message leaks
  to the UI.** Everything else shows "See browser console for
  details." Throw `UserFacingError` at curated boundaries only.
  Details: `docs/security.md`.

## Top gotchas (real breakage if forgotten)

- **`[hidden] { display: none !important }` in `index.html` is
  load-bearing** — without `!important`, `display: flex` class
  rules beat the UA `[hidden]` rule (equal specificity, author
  wins) and overlays stay visible.
- **Ribbon menus: two workarounds, don't remove them.**
  (1) Only seeded skeleton keys accept `appendTo` — the File tab
  exists by repurposing `ribbon.others`. (2) Submenu children added
  via `addSubmenu` render empty; the fix is a direct
  `menuSvc.mergeMenu` of each leaf's `__getSchema()` into the
  submenu key. (3) Commands must pre-register under the same ID as
  the leaf, reached via a throwaway `__sheet-bro.bootstrap` menu.
  Details: `docs/ribbon.md`.
- **WebCrypto requires HTTPS** (except `localhost`). If a user
  reports "data didn't persist", ask about HTTPS first.
- **Z-index ≥ 9998** for anything that must sit over the Univer
  ribbon. Details: `docs/ribbon.md`.
- **Ribbon label override**: `ribbon.others` is relabelled `'File'`
  in `src/app.ts:110`. Don't let stale doc confuse you into
  thinking it's still `'Export'`.
- **SQL dialect normalizer is lossy, not a migrator.** Dumps in
  anything other than MySQL/MariaDB (with default escape mode) or
  plain SQLite are out of scope. Details: `docs/sql-import.md`.

## File map

```
index.html                       # Static DOM + inline critical CSS + CSP <meta>
src/
├── main.ts                      # Entry: calls initApp().
├── app.ts                       # Lifecycle, Univer setup, drop handling,
│                                # ribbon menu, persistence wiring, modals,
│                                # cross-tab listeners, overlay toggling.
├── file-router.ts               # detectFileKind / importerForKind / labelForKind.
├── cell.ts                      # normalizeCell: importer → Univer cell.
├── workbook-shape.ts            # buildWorkbookShape: LoadedSheet[] → snapshot.
├── snapshot-shape.ts            # isPersistedSnapshot: gate before createWorkbook.
├── persistence.ts               # IndexedDB + WebCrypto. docs/persistence.md.
├── tab-names.ts                 # Cross-tab localStorage registry, fileBasedTabName.
├── user-facing-error.ts         # UserFacingError + toUserMessage.
├── sqljs.ts                     # Shared lazy sql.js loader.
├── sw-register.ts               # PWA service worker registration.
├── launch-queue.ts              # PWA File Handling API (installed desktop PWA).
├── test-helpers/fake-univer.ts  # Test stub for univerAPI.
├── importers/                   # CSV/XLSX/SQL → LoadedSheet[].
│   └── sql-dialect.ts           # MySQL/MariaDB → SQLite normalizer.
└── exporters/                   # Workbook → file (CSV/XLSX/SQL/SQLite).
    ├── shared.ts                # Pure core: TableSpec, sanitize, infer.
    └── safe-export.ts           # AES-256 encrypted ZIP wrapper (@zip.js/zip.js).
```

## Deeper docs

- `docs/architecture.md` — file tree detail, 11-step lifecycle,
  DOM-attribute UI state, extraction targets for `app.ts`.
- `docs/ribbon.md` — mergeMenu trap, submenu-children trap,
  bootstrap-menu escape hatch, full menu inventory, z-index tiers.
- `docs/persistence.md` — AES-GCM specifics, TTL, localStorage tab
  registry (why not BroadcastChannel), cross-tab `storage` events.
- `docs/sql-import.md` — lazy sql.js, magic dispatch, full dialect
  normalizer rules, intentional gaps (PostgreSQL, triggers).
- `docs/exporters.md` — always-quote policy, header heuristic,
  column-type inference, SQL batching, Safe Export.
- `docs/security.md` — CSP directive-by-directive,
  `ignore-scripts` rationale, `UserFacingError` contract.
- `docs/dependencies.md` — pinning rules, why `react` / `react-dom`
  / `@zip.js/zip.js` are direct deps, files to leave alone.
