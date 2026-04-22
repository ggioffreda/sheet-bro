# Security

## Content Security Policy

A `<meta http-equiv="Content-Security-Policy">` ships in
`index.html` so hardening is not contingent on the operator setting
response headers. The directives are tight and deliberate:

- `script-src 'self' 'wasm-unsafe-eval'` — `'wasm-unsafe-eval'` is
  required by sql.js to compile the WASM module. No `'unsafe-inline'`
  on scripts; the module script is external.
- `style-src 'self' 'unsafe-inline'` — required for the inline
  `<style>` block that prevents FOUC. Keep all styling inline or in
  `/src`-imported CSS; don't introduce third-party stylesheets.
- `img-src 'self' data: blob:` — `data:` covers inline SVGs emitted
  by Univer; `blob:` covers URLs created for XLSX export preview.
- `worker-src 'self' blob:` — Univer spins up blob workers.
- `connect-src 'self'`, `form-action 'none'`, `base-uri 'self'` —
  the app makes no network calls and has no forms; locking these
  down is free defense-in-depth.
- `frame-ancestors` is **ignored in `<meta>`** — clickjacking
  protection still needs an `X-Frame-Options` / CSP response header
  set by whatever serves `dist/`. The README's nginx example covers
  this.

If a new dep needs `eval` or `unsafe-eval`, that's a hard stop —
find another dep or pre-compile.

## Supply-chain hygiene — `ignore-scripts=true`

`.npmrc` sets `ignore-scripts=true`. This blocks every dependency's
`preinstall` / `install` / `postinstall` script from running during
`pnpm install`, neutering the most common npm supply-chain attack
vector (eslint-scope-style, ua-parser-js-style, etc). It is
intentional and load-bearing.

Modern `esbuild` (Vite's transitive dep) ships its native binary
via platform-specific packages (`@esbuild/linux-x64`, etc.) instead
of via a postinstall download, so this setting does not break the
build. If you ever add a dep that legitimately requires a
postinstall script, prefer a narrow `pnpm.onlyBuiltDependencies`
allowlist in `package.json` over flipping `ignore-scripts` back to
`false`.

## Error-message gating — `UserFacingError`

`src/user-facing-error.ts` defines:

```ts
export class UserFacingError extends Error { readonly userFacing = true }
export function toUserMessage(err: unknown, fallback: string): string
```

The rule: `notify()` in `app.ts` surfaces error strings to the
user. Raw exception messages routinely contain internals (library
stack hints, file paths, DB lock details) that shouldn't leak.
`toUserMessage(err, fallback)` enforces a two-mode policy:

- If `err` is a `UserFacingError`, append its message to the
  fallback — it's curated text.
- Otherwise, return `<fallback> See browser console for details.`

Throw `UserFacingError` at boundaries where the message is already
known-safe. Current call sites:

- `src/app.ts:661` — import-timeout race.
- `src/importers/sql.ts:30` — over the 50 000-statement cap.
- `src/importers/xlsx.ts:33` — unexpected cell types in a sheet.

Size-limit rejection in `onDrop` (`src/app.ts:632-637`) is a direct
`notify(..., sticky=true)` without going through `toUserMessage`,
because the message is fixed-text, not exception-derived.

Everywhere else, let the fallback path trigger.

## Deployment headers — `public/_headers`

`public/_headers` ships with the build and is honoured by Cloudflare
Pages / Netlify / any host that reads the same format. It sets
`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, a `Permissions-Policy` that disables
geolocation/camera/microphone/FLoC, and a CSP identical to the meta
CSP plus `frame-ancestors 'none'` (the one directive a `<meta>` CSP
can't enforce). Hosts that ignore `_headers` still need the
equivalent block set at the server layer — see the nginx example in
`README.md`.

The service worker (`public/sw.js`) also synthesises the same headers
onto its navigation responses as a belt-and-braces fallback for hosts
that can't set them, but that path is only active from the second
visit onward (once the SW has installed). Do not rely on the SW alone.

## Heavy-parser sandbox — `src/workers/parser.worker.ts`

SQL imports (both text dumps and binary SQLite files) run inside a
module Web Worker so the `IMPORT_TIMEOUT_MS` race in `runImport` can
`terminate()` a parser that refuses to yield on a pathological input.
sql.js runs WASM in-process and has historically been the most
plausible tab-freeze vector.

XLSX parsing stays on the main thread: `read-excel-file/browser`
depends on `DOMParser`, which isn't available in Workers. XLSX risk
is still bounded by the 50 MB pre-decompression cap in
`src/app.ts::MAX_FILE_BYTES`. CSV stays on the main thread too —
PapaParse over a capped input is fast enough that the postMessage
copy isn't worth it.

The worker is same-origin and inherits the page CSP — no SW contract
change, no new privileges.

## Safe Export — zip.js KDF trade-off

The encrypted-ZIP path (`src/exporters/safe-export.ts`) uses WinZip AE-2
(AES-256 with PBKDF2-HMAC-SHA1, 1000 iterations — a zip.js library
constant). This KDF is weak by modern standards; offline brute-force
against short passwords is cheap on GPUs. The 16-character minimum
enforced in `promptPassword` (`src/app.ts`) is chosen to stay ahead of
current brute-force economics for a passphrase-style secret. For
higher-value data, prefer a 5-word Diceware phrase.

Switching to Argon2id or scrypt would require forking zip.js or
abandoning the ZIP-compat format — neither is worthwhile while the
primary exfil vector (the user's own disk) is already trust-boundary
equivalent.

## Accepted weaknesses

### AAD binding on IndexedDB ciphertexts

Snapshots written by `persistence.ts` are AES-GCM encrypted with a
non-extractable CryptoKey held in sessionStorage, but the ciphertext
does not bind the IndexedDB record key via associated data (AAD). An
attacker with IndexedDB write access but no JS execution could in
principle swap one tab's ciphertext into another tab's slot; AES-GCM
would still decrypt because the key and nonce are valid.

This is accepted. The non-extractable key already prevents raw-key
exfil from a disk copy of IndexedDB; any in-page attacker who can
swap sessionStorage is equally able to call `subtle.decrypt` on the
live key directly. AAD only helps the narrow "IDB tamper without JS"
threat, which is not in our model. Revisit if that ever changes.



### Tab names in plaintext in `localStorage`

The cross-tab registry stores entries under `sheet-bro:tab:<tabId>` as
plaintext JSON including the display name, which `fileBasedTabName`
derives from the dropped filename. A filename can carry PII.

This is accepted. Rationale:

- The file is already on the user's machine. The app makes no network
  calls (`connect-src 'self'` in the CSP is empty in practice — there
  is no backend), so the name never leaves the device.
- Entries are removed on clean tab close (`beforeunload` →
  `removeTabRegistry`), and on a liveness sweep that runs every 30 s
  (`pruneStaleTabRegistry` in `src/persistence.ts`). A tab that
  crashed or was force-killed stops being reachable on its Web Lock
  almost immediately, and its entry is deleted the next time any
  other tab sweeps.
- The 24 h TTL on IndexedDB records (`MAX_AGE_MS`) bounds the window
  further.

Encrypting the registry would cost a startup IndexedDB round-trip per
peer without any threat-model benefit under this deployment.
