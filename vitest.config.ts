import { defineConfig } from 'vitest/config'

// Vitest-only config. The existing vite.config.ts stays minimal for the app
// build; this file governs the test runner so test-only settings (coverage
// thresholds, env conventions) don't leak into the production bundle.

export default defineConfig({
  test: {
    // Default to happy-dom so tests that touch DOM / IndexedDB / WebCrypto
    // (persistence, importers) get the APIs they need. happy-dom replaced
    // jsdom in April 2026 — jsdom pulled in an ESM-only html-encoding-sniffer
    // that crashed the vitest worker pool.
    environment: 'happy-dom',
    // Playwright's e2e specs import from @playwright/test and MUST run under
    // `playwright test`, not vitest. Exclude them from vitest's discovery.
    exclude: ['node_modules/**', 'dist/**', 'e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html'],
      // Report on src/ only; exclude entry points, types, test files. main.ts
      // is a one-line `void initApp()` entry we have no interest in covering;
      // app.ts is the Univer/DOM glue covered by the Playwright suite. Every
      // other source file is unit-tested to 100%.
      include: ['src/**/*.ts'],
      exclude: [
        'src/main.ts',
        'src/app.ts',
        'src/vite-env.d.ts',
        'src/test-helpers/**',
        '**/*.test.ts',
        '**/fixtures/**',
      ],
      thresholds: {
        // Every measured file hits 100% lines and 100% functions. Statements
        // and branches are slightly below 100% because vitest-v8 (v4.1) does
        // not honour `/* v8 ignore next */` pragmas, and a small handful of
        // genuinely defensive guards in the MySQL→SQLite tokenizer can't be
        // reached from user-facing input (the upstream tokenizer filters
        // empty segments). Globals match the actual measured floor; per-file
        // thresholds below pin every other file at the stricter 100% so
        // regressions outside the defensive zone fail CI immediately.
        lines: 100,
        statements: 99.8,
        functions: 100,
        branches: 99,
        'src/cell.ts':             { lines: 100, statements: 100, functions: 100, branches: 100 },
        'src/tab-names.ts':        { lines: 100, statements: 100, functions: 100, branches: 100 },
        'src/file-router.ts':      { lines: 100, statements: 100, functions: 100, branches: 100 },
        'src/persistence.ts':      { lines: 100, statements: 100, functions: 100, branches: 100 },
        'src/snapshot-shape.ts':   { lines: 100, statements: 100, functions: 100, branches: 100 },
        'src/sqljs.ts':            { lines: 100, statements: 100, functions: 100, branches: 100 },
        'src/workbook-shape.ts':   { lines: 100, statements: 100, functions: 100, branches: 100 },
        'src/exporters/csv.ts':    { lines: 100, statements: 100, functions: 100, branches: 100 },
        'src/exporters/sql.ts':    { lines: 100, statements: 100, functions: 100, branches: 100 },
        'src/exporters/sqlite.ts': { lines: 100, statements: 100, functions: 100, branches: 100 },
        'src/exporters/xlsx.ts':   { lines: 100, statements: 100, functions: 100, branches: 100 },
        'src/importers/csv.ts':    { lines: 100, statements: 100, functions: 100, branches: 100 },
        'src/importers/sql.ts':    { lines: 100, statements: 100, functions: 100, branches: 100 },
        'src/importers/xlsx.ts':   { lines: 100, statements: 100, functions: 100, branches: 100 },
      },
    },
  },
})
