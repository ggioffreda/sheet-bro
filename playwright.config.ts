import { defineConfig, devices } from '@playwright/test'

const PORT = 5174

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'line' : [['list']],
  // Regenerate binary e2e fixtures (sample.xlsx, sample.sqlite, sample.sql)
  // from the canonical e2e/fixtures/sample.csv before any spec runs.
  globalSetup: './e2e/fixtures/build.ts',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Use Vite's dev server so the smoke test doesn't require a separate
  // `pnpm build` step. --strictPort fails fast if 5174 is already occupied
  // rather than silently reshuffling the URL.
  webServer: {
    // VITE_E2E=1 is the only switch that enables window.__sheetbro in the
    // app — without it the E2E helpers (readCell/writeCell) would have no
    // way to introspect workbook state without clicking through the UI.
    // Production builds never set the flag, so the hook stays dev-only.
    command: `VITE_E2E=1 pnpm dev --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
