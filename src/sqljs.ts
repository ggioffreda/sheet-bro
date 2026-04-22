import type { SqlJsStatic } from 'sql.js'

let cached: Promise<SqlJsStatic> | null = null

export function loadSqlJs(): Promise<SqlJsStatic> {
  if (!cached) {
    cached = (async () => {
      const mod = await import('sql.js')
      const wasm = await import('sql.js/dist/sql-wasm.wasm?url')
      return mod.default({ locateFile: () => wasm.default })
    })()
  }
  return cached
}
