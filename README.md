# sheet-bro

A browser-only spreadsheet that opens CSV, XLSX, and SQL files with zero
backend and zero framework.
Drop a file onto the page, edit it in a full-screen workbook, export back out.
All data stays on the device, encrypted at rest, scoped to the browser tab.

Use [sheet-bro on GitHub pages](https://ggioffreda.github.io/sheet-bro/).

## Acknowledgements

Built on top of [Univer](https://univer.ai/),
[PapaParse](https://www.papaparse.com/), and the
[read/write-excel-file](https://gitlab.com/catamphetamine) libraries.

## What it does

- **Drag-and-drop import** — `.csv`, `.xlsx`, `.sqlite` / `.db` / `.sqlite3`,
  and `.sql` dumps. XLSX preserves all sheets. SQLite files open with one
  sheet per table. SQL dumps (SQLite, `mysqldump`, MariaDB) are loaded into
  an in-memory SQLite; a dialect normalizer strips MySQL/MariaDB-specific
  syntax. Routines and server-side directives (`SET`, `LOCK TABLES`) are
  dropped. PostgreSQL `pg_dump` is not supported.
- **Full spreadsheet** — formulas, filters, formatting, courtesy of Univer.
- **Export** — CSV (active sheet), XLSX (whole workbook), SQL (`CREATE TABLE`
  + `INSERT` per sheet, strict ANSI with double-quoted identifiers), and
  SQLite binary. Sheet names sanitize to `[A-Za-z_][A-Za-z0-9_]*`. Row 1 is
  treated as a header if every cell is a non-empty string not starting with
  a digit or `+`/`-`; otherwise columns become `col1..colN`. Per-column
  types infer to `INTEGER` / `REAL` / `TEXT`, with leading-zero strings,
  thousands-separated strings, and 15+ digit integers pinned to TEXT to
  preserve exact values.
- **Per-tab persistence** — your work survives refresh, tabs are isolated.
  Encrypted in IndexedDB; key lives only in `sessionStorage`.
- **Installable PWA** — "Add to Home Screen" / "Install app" works with a
  real icon and name. On installed desktop Chrome/Edge, sheet-bro can
  register as the default app for `.csv` / `.xlsx` / `.sqlite` / `.db` /
  `.sql` so double-click opens the file directly.

## Tech stack

Vanilla TypeScript 5.9 + [Vite 7](https://vite.dev/). No UI framework.
[Univer 0.20](https://univer.ai/) for the workbook,
[PapaParse 5.5](https://www.papaparse.com/) for CSV,
[read/write-excel-file 8.0/3.0](https://gitlab.com/catamphetamine) for XLSX,
[sql.js 1.14](https://sql.js.org/) (lazy-loaded) for SQL import/export,
WebCrypto + IndexedDB for persistence. The entire app ships as static
assets — no backend.

## Getting started

Requires Node **24.14.1** and pnpm **10.33.0** (declared in `package.json`).
Node ≥ 20.19 works for `dev` and typecheck; Vite 7 needs 20.19+ for `build`.

```bash
pnpm install
pnpm dev            # Vite dev server with HMR
pnpm build          # typecheck + production build into dist/
pnpm preview        # serve dist/ locally
```

Open the dev URL, drop a file onto the page, and you're in.

## Persistence and threat model

`src/persistence.ts` encrypts the workbook snapshot with AES-GCM-256 and
writes the ciphertext to IndexedDB, keyed by a per-tab UUID. The key and
UUID live in `sessionStorage` — both die with the tab. Saves are debounced
to 400 ms; records carry a `lastSeen` timestamp and anything older than 24 h
is pruned on mount.

What this does and doesn't protect against:

- ✅ Other tabs of the same origin can't read this tab (no key).
- ✅ Inspecting IndexedDB after the tab closes shows only ciphertext.
- ❌ XSS in the live tab can read the key from `sessionStorage`. This is
  defense-in-depth against cross-tab and post-close access, not a vault.
- ℹ️ Browsers copy `sessionStorage` when a tab is duplicated, but the
  Web Locks API detects the clone (the original still holds the lock on
  the tab UUID) and the duplicate mints a fresh identity — so the two
  tabs stay isolated rather than racing on the same record.

## Deploy as a static site

`pnpm build` emits a `dist/` directory. Copy it to any static host and point
the webroot at it. Nothing else from the repo needs to be on the server.

For subpath deployments (e.g. GitHub Pages at `https://user.github.io/sheet-bro/`),
set `BASE_URL=/sheet-bro/` in the build environment — the shipped workflow at
`.github/workflows/static.yml` wires this up automatically from
`actions/configure-pages`. The service worker derives its base from its
registration scope at runtime, so the same `dist/` works under any base.

Server requirements:

1. **HTTPS is mandatory.** `crypto.subtle` is disabled on plain HTTP
   (except `localhost`); without HTTPS nothing persists.
2. **MIME**: serve `site.webmanifest` as `application/manifest+json`.
3. **Cache**: `index.html`, `sw.js`, and `site.webmanifest` →
   `Cache-Control: no-cache`; `assets/*` →
   `public, max-age=31536000, immutable` (Vite content-hashes filenames).
4. **Compression**: gzip or brotli for `.js`, `.css`, `.html`, `.svg`,
   `.webmanifest`.

Managed hosts (Netlify, Cloudflare Pages, Vercel, GitHub Pages, S3 +
CloudFront) work out of the box — build command `pnpm build`, publish
directory `dist`.

### Example: nginx

```nginx
server {
  listen 443 ssl http2;
  server_name sheet-bro.example.com;

  ssl_certificate     /etc/letsencrypt/live/sheet-bro.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/sheet-bro.example.com/privkey.pem;

  root /var/www/sheet-bro;
  index index.html;

  gzip on;
  gzip_types text/css application/javascript application/manifest+json image/svg+xml;

  add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "no-referrer" always;
  add_header Permissions-Policy "interest-cohort=(), geolocation=(), camera=(), microphone=()" always;
  add_header Content-Security-Policy "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'none';" always;

  location = /index.html { add_header Cache-Control "no-cache"; }
  location /assets/     { add_header Cache-Control "public, max-age=31536000, immutable"; }
}
```

CSP notes: `'unsafe-inline'` in `style-src` is required for the inline
`<style>` block in `index.html` (FOUC prevention); `'wasm-unsafe-eval'` is
required for sql.js; `worker-src blob:` is required by Univer's web worker.
`frame-ancestors 'none'` only works from the HTTP header — the in-page
`<meta>` CSP in `index.html` is a fallback for misconfigured servers.

### Service worker

`pnpm build` emits `dist/sw.js` — a hand-written, dependency-free service
worker that precaches `index.html` and hashed `assets/*` and runtime-caches
`sql-wasm*.wasm` on first use.

- Updates are explicit: a new SW stays in `waiting` until the user accepts
  a "new version available" toast (or every tab closes). No
  `skipWaiting()`, no `clients.claim()`.
- The SW injects `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, and `Permissions-Policy` onto navigations it serves,
  but server response headers remain authoritative. HSTS **must** come
  from the server.
- Kill switch: ship a `sw.js` that clears caches and
  `self.registration.unregister()`s, then reloads. Users who don't revisit
  during the browser's 24 h update window must clear site data manually.
- Registration is gated to production — `pnpm dev` and the E2E suite
  (`VITE_E2E=1`) never register the SW.
