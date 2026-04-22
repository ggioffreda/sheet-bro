import { expect, test } from '@playwright/test'

// Guard against accidental drift in the meta-CSP shipped with index.html.
// The directives below are the exact security contract the app depends on:
//   - `script-src 'self' 'wasm-unsafe-eval'` (sql.js needs WASM compile)
//   - `worker-src 'self' blob:` (Univer's blob workers + our parser worker)
//   - `object-src 'none'` / `base-uri 'self'` / `form-action 'none'` —
//     defence-in-depth directives that are free wins, don't let them vanish.
// If this test fails after an intentional change, update the assertion AND
// `docs/security.md` in the same commit.

test('meta-CSP directives have not drifted', async ({ page }) => {
  await page.goto('/')
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content')
  expect(csp).toBeTruthy()
  const directives = csp!
  expect(directives).toContain("default-src 'self'")
  expect(directives).toContain("object-src 'none'")
  expect(directives).toContain("script-src 'self' 'wasm-unsafe-eval'")
  expect(directives).toContain("worker-src 'self' blob:")
  expect(directives).toContain("connect-src 'self'")
  expect(directives).toContain("base-uri 'self'")
  expect(directives).toContain("form-action 'none'")
})
