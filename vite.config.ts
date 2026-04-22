import { defineConfig } from 'vite'

export default defineConfig({
  build: { sourcemap: false },
  // The parser worker dynamically `import()`s sql.js, which triggers
  // code-splitting. Rollup refuses UMD/IIFE output for split workers, so
  // force ESM — matches the `{ type: 'module' }` we already pass at
  // construction.
  worker: { format: 'es' },
})
