# Dependencies

## Hygiene rules

- **Pin every direct dependency to an exact version** — no `^`, no
  `~`, no ranges. The lockfile pins transitive deps automatically.
- Before adding a dep, check that it's actively maintained (recent
  releases, no abandoned issues), MIT-licensed (or compatible), and
  has no open CVEs.
- Avoid packages published <7 days ago — wait for the dust to
  settle on fresh releases.
- Run `pnpm audit --audit-level low` after every `pnpm add` and
  resolve anything that lights up.

## Why `react` / `react-dom` are direct deps

They aren't used by app code. They appear in `package.json`
because `@univerjs/ui` (pulled in through `@univerjs/presets`)
declares them as `peerDependencies`, and pnpm 10's strict-peer mode
requires the consumer to declare peer deps explicitly. Don't be
tempted to remove them — `pnpm install` will fail.

## Why `@zip.js/zip.js` is a direct dep

Used only by `src/exporters/safe-export.ts` to produce
AES-encrypted ZIP archives for the Safe Export menu. Chosen over
`jszip` because jszip doesn't support AES encryption — it only
writes legacy zipcrypto, which is cryptographically broken.
`@zip.js/zip.js` supports AES-128 / AES-192 / AES-256
(`encryptionStrength: 1 | 2 | 3`); we use AES-256.

## Files to leave alone unless asked

- `public/favicon.ico`, `public/favicon-*.png`, `public/icon-*.png`,
  `public/apple-touch-icon.png` — generated from the source logo
  via `magick` commands. Don't hand-edit; regenerate from a new
  source PNG.
- `package.json` `engines` and `packageManager` fields are
  deliberately pinned. Don't bump without the user asking.
