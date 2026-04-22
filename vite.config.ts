import { defineConfig } from 'vite'

export default defineConfig({
  // Subpath deployments (e.g. GitHub Pages at /sheet-bro/) set BASE_URL in
  // CI; local dev and root-hosted deploys leave it unset.
  base: process.env.BASE_URL ?? '/',
  build: { sourcemap: false },
  // The parser worker dynamically `import()`s sql.js, which triggers
  // code-splitting. Rollup refuses UMD/IIFE output for split workers, so
  // force ESM — matches the `{ type: 'module' }` we already pass at
  // construction.
  worker: { format: 'es' },
})
