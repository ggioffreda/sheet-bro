// Heavy-parser sandbox. Lives on its own thread so the main-thread
// import-timeout race can `terminate()` a parser that refuses to yield
// on a hostile file (pathological SQL dump, decompression-style sql.js
// work). Only SQL parsing runs here: XLSX parsing uses
// `read-excel-file/browser`, which depends on `DOMParser` — only
// available on the main thread. CSV is fast enough that offloading
// isn't worth the postMessage cost.
//
// Contract: exactly one job per Worker instance. Caller posts a
// WorkerJob, awaits a single WorkerResult, then terminates the worker.

import { parseSqlDump, parseSqliteBytes } from '../importers/sql'
import type { LoadedSheet } from '../importers'
import { UserFacingError } from '../user-facing-error'

export type WorkerJob =
  | { job: 'sql-dump'; text: string }
  | { job: 'sqlite'; bytes: Uint8Array }

export type WorkerResult =
  | { ok: true; sheets: LoadedSheet[] }
  | { ok: false; userFacing: boolean; message: string }

// "SQLite format 3\0" — 16 bytes. Mirrored from file-router.ts so the
// worker can reject a mismatched sqlite job independently; defense in
// depth against a future refactor that routes the wrong blob here.
const SQLITE_MAGIC = [
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66,
  0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
]
// "PK\x03\x04" — XLSX (ZIP). If someone ever routes an XLSX to this
// worker by mistake, refuse it rather than feeding it to sql.js.
const XLSX_MAGIC = [0x50, 0x4b, 0x03, 0x04]

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false
  }
  return true
}

// Pure dispatcher — exported so tests can exercise every branch without
// spinning up an actual Worker.
export async function dispatchParserJob(msg: WorkerJob): Promise<WorkerResult> {
  try {
    let sheets: LoadedSheet[]
    if (msg.job === 'sql-dump') {
      if (startsWith(bytesFromText(msg.text), SQLITE_MAGIC) || startsWith(bytesFromText(msg.text), XLSX_MAGIC)) {
        throw new UserFacingError('File type mismatch — refusing to parse.')
      }
      sheets = await parseSqlDump(msg.text)
    } else {
      if (!startsWith(msg.bytes, SQLITE_MAGIC)) {
        throw new UserFacingError('File type mismatch — refusing to parse.')
      }
      sheets = await parseSqliteBytes(msg.bytes)
    }
    return { ok: true, sheets }
  } catch (err) {
    const userFacing = err instanceof UserFacingError
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, userFacing, message }
  }
}

function bytesFromText(text: string): Uint8Array {
  // Only the first 16 code units matter for magic-byte detection; avoid
  // encoding the whole string.
  const head = text.slice(0, 16)
  const out = new Uint8Array(head.length)
  for (let i = 0; i < head.length; i++) out[i] = head.charCodeAt(i) & 0xff
  return out
}

/* v8 ignore start */
// Wire-up — stripped from coverage because `self.postMessage` only runs
// inside a real Worker realm, and the routing logic is already covered
// via `dispatchParserJob`.
if (typeof self !== 'undefined' && typeof (self as unknown as Worker).postMessage === 'function') {
  self.addEventListener('message', async (e: MessageEvent<WorkerJob>) => {
    const result = await dispatchParserJob(e.data)
    ;(self as unknown as Worker).postMessage(result)
  })
}
/* v8 ignore stop */
