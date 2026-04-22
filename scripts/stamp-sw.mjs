// Post-build step: walks dist/, builds the service worker's precache
// manifest and a content-hashed cache version, and writes both into
// dist/sw.js by replacing the placeholder tokens.
//
// Node built-ins only. Any dependency added here would run at build
// time with full filesystem access — keep this script dep-free.

import { createHash } from 'node:crypto'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const DIST = resolve(__dirname, '..', 'dist')
const SW_PATH = join(DIST, 'sw.js')

// What to precache: index.html, every assets/* file except the SW
// itself, favicons, manifest, and the WASM file (runtime-cached).
// Anything we don't precache is either pass-through or runtime-cached.
const PRECACHE_GLOBS = [
  /^index\.html$/,
  /^assets\//,
  /^favicon\.ico$/,
  /^favicon-\d+x\d+\.png$/,
  /^apple-touch-icon\.png$/,
  /^icon-\d+\.png$/,
  /^site\.webmanifest$/,
]

// Must stay out of the precache (runtime-cached or intentionally skipped).
const SKIP = [
  /^sw\.js$/,
  /\.map$/,
  /\/sql-wasm[^/]*\.wasm$/,
]

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const out = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await walk(full)))
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
  return out
}

function matches(patterns, path) {
  return patterns.some((re) => re.test(path))
}

async function main() {
  let swStat
  try {
    swStat = await stat(SW_PATH)
  } catch {
    throw new Error(`dist/sw.js not found — did Vite copy public/sw.js? Expected at ${SW_PATH}`)
  }
  if (!swStat.isFile()) throw new Error(`${SW_PATH} is not a file`)

  const files = await walk(DIST)
  const relFiles = files.map((f) => relative(DIST, f).replaceAll('\\', '/'))

  // Manifest entries are kept as base-relative paths (no leading slash).
  // sw.js prepends the deployment base (derived from the registration
  // scope) at runtime so the same build works at '/' or '/sheet-bro/'.
  const manifest = relFiles
    .filter((p) => matches(PRECACHE_GLOBS, p))
    .filter((p) => !matches(SKIP, p))
    .sort()

  if (!manifest.includes('index.html')) {
    throw new Error('precache manifest missing index.html — build output looks incomplete')
  }

  const hasher = createHash('sha256')
  for (const rel of manifest) {
    const abs = join(DIST, rel.replace(/^\//, ''))
    const bytes = await readFile(abs)
    hasher.update(rel)
    hasher.update('\0')
    hasher.update(bytes)
    hasher.update('\0')
  }
  const version = hasher.digest('hex').slice(0, 16)

  const swSrc = await readFile(SW_PATH, 'utf8')
  if (!swSrc.includes('__ASSET_MANIFEST__') || !swSrc.includes('__CACHE_VERSION__')) {
    throw new Error('sw.js is missing placeholder tokens — refusing to stamp')
  }
  const stamped = swSrc
    .replaceAll('__ASSET_MANIFEST__', JSON.stringify(manifest))
    .replaceAll('__CACHE_VERSION__', version)

  await writeFile(SW_PATH, stamped, 'utf8')

  console.log(`[stamp-sw] version=${version} files=${manifest.length}`)
}

main().catch((err) => {
  console.error('[stamp-sw] failed:', err)
  process.exit(1)
})
