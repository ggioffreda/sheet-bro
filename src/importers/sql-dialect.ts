import { UserFacingError } from '../user-facing-error'

// Lossy MySQL / MariaDB → SQLite normalizer.
//
// Goal: accept a `.sql` dump from `sqlite3 .dump` or `mysqldump` (default
// or `--compatible=ansi`) and emit SQL that sql.js can execute, preserving
// table structure and data rows. This is NOT a faithful migrator — indexes,
// storage engines, charsets, constraints like ON UPDATE CURRENT_TIMESTAMP,
// and anything that doesn't carry row data are dropped when SQLite can't
// parse them.
//
// Architecture: a character-aware tokenizer splits input into statements
// while respecting string literals, block/line comments, and DELIMITER
// directives. Each statement is then normalized via regex passes that run
// only on "code" regions — placeholders protect string literals so that
// `ENGINE=InnoDB` inside a VARCHAR never gets stripped.

// Array form — useful for callers that need to count or cap the number
// of statements before handing them to sql.js. Each element includes its
// trailing `;` so re-joining with `\n` matches `normalizeToSqlite`.
const MAX_STATEMENT_BYTES = 5 * 1024 * 1024

export function normalizeToSqliteStatements(input: string): string[] {
  const statements = tokenizeStatements(input)
  for (const raw of statements) {
    if (raw.length > MAX_STATEMENT_BYTES) {
      throw new UserFacingError(
        `SQL import rejected: a single statement exceeds the ${MAX_STATEMENT_BYTES / 1024 / 1024} MB limit.`,
      )
    }
  }
  const out: string[] = []
  for (const raw of statements) {
    const norm = normalizeStatement(raw)
    if (norm) out.push(norm + ';')
  }
  return out
}

export function normalizeToSqlite(input: string): string {
  return normalizeToSqliteStatements(input).join('\n')
}

// Heuristic — true if the text looks like a MySQL/MariaDB dump rather
// than a SQLite-style one. Currently unused by the pipeline (the
// normalizer is idempotent on SQLite dumps) but exported for diagnostics
// and potential future conditional behavior.
export function looksLikeMysql(sql: string): boolean {
  return (
    /`[^`]+`/.test(sql) ||
    /\bENGINE\s*=/i.test(sql) ||
    /\/\*!/.test(sql) ||
    /\bLOCK\s+TABLES\b/i.test(sql) ||
    /\bSET\s+@@/i.test(sql) ||
    /\bAUTO_INCREMENT\b/i.test(sql)
  )
}

// --- Statement tokenizer ----------------------------------------------------

// Split raw input into statement strings. Respects:
//   - single-quoted strings with \' and '' escapes
//   - double-quoted strings with \" and "" escapes (MySQL treats these as
//     strings by default; ANSI mode treats them as identifiers — either way
//     we just need to not break inside them)
//   - backtick-quoted identifiers with `` escape
//   - /* ... */ block comments (including /*! ... */ conditional hints)
//   - -- line comments (to end-of-line)
//   - # line comments (MySQL) (to end-of-line)
//   - DELIMITER directive on its own line — changes the terminator
//     (default ";"). The DELIMITER line is NOT included in output.
//
// Returns raw statement text WITHOUT the trailing delimiter and with
// inline strings/comments preserved. Normalization happens later.
function tokenizeStatements(input: string): string[] {
  const out: string[] = []
  let delim = ';'
  let buf = ''
  let i = 0
  const n = input.length

  while (i < n) {
    // Try to detect DELIMITER directive at the start of a line.
    if (isAtLineStart(input, i)) {
      const m = input.slice(i).match(/^[ \t]*DELIMITER[ \t]+(\S+)[ \t]*(?:\r?\n|$)/i)
      if (m) {
        // Flush current buffer as a statement (without the delim)
        if (buf.trim()) out.push(buf)
        buf = ''
        delim = m[1]
        i += m[0].length
        continue
      }
    }

    const ch = input[i]
    const next = input[i + 1]

    // Line comments
    if (ch === '-' && next === '-' && (input[i + 2] === ' ' || input[i + 2] === '\t' || input[i + 2] === undefined || input[i + 2] === '\n' || input[i + 2] === '\r')) {
      const nl = input.indexOf('\n', i)
      if (nl === -1) { i = n } else { i = nl + 1 }
      continue
    }
    if (ch === '#') {
      const nl = input.indexOf('\n', i)
      if (nl === -1) { i = n } else { i = nl + 1 }
      continue
    }

    // Block comments — including /*! ... */ conditional hints
    if (ch === '/' && next === '*') {
      const end = input.indexOf('*/', i + 2)
      if (end === -1) { i = n } else { i = end + 2 }
      continue
    }

    // Single-quoted string
    if (ch === "'") {
      const { consumed, text } = consumeQuoted(input, i, "'")
      buf += text
      i += consumed
      continue
    }

    // Double-quoted string (preserve as-is; could be identifier or string)
    if (ch === '"') {
      const { consumed, text } = consumeQuoted(input, i, '"')
      buf += text
      i += consumed
      continue
    }

    // Backtick-quoted identifier
    if (ch === '`') {
      const { consumed, text } = consumeQuoted(input, i, '`')
      buf += text
      i += consumed
      continue
    }

    // Current delimiter?
    if (input.startsWith(delim, i)) {
      if (buf.trim()) out.push(buf)
      buf = ''
      i += delim.length
      continue
    }

    buf += ch
    i += 1
  }

  if (buf.trim()) out.push(buf)
  return out
}

function isAtLineStart(s: string, i: number): boolean {
  if (i === 0) return true
  // Walk back over spaces/tabs; a preceding newline (or BOF) means line-start.
  let j = i - 1
  while (j >= 0 && (s[j] === ' ' || s[j] === '\t')) j--
  return j < 0 || s[j] === '\n'
}

// Consume a quoted segment starting at i (input[i] === openQuote).
// Handles doubled-quote escape (e.g. '') and backslash escapes for single
// and double quotes. Returns the raw substring including the quotes plus
// the number of characters consumed.
function consumeQuoted(
  s: string,
  i: number,
  quote: "'" | '"' | '`',
): { consumed: number; text: string } {
  const start = i
  i += 1 // skip opening quote
  const n = s.length
  const supportsBackslash = quote !== '`'
  while (i < n) {
    const ch = s[i]
    if (supportsBackslash && ch === '\\' && i + 1 < n) {
      i += 2
      continue
    }
    if (ch === quote) {
      if (s[i + 1] === quote) {
        i += 2
        continue
      }
      i += 1
      return { consumed: i - start, text: s.slice(start, i) }
    }
    i += 1
  }
  // Unterminated — consume to end
  return { consumed: n - start, text: s.slice(start) }
}

// --- Per-statement normalization -------------------------------------------

function normalizeStatement(raw: string): string | null {
  // tokenizeStatements filters empty buffers before pushing, so `!trimmed`
  // and the `|| null` below are defensive against a future tokenizer change;
  // vitest-v8 reports them as uncovered and per-file thresholds accept it.
  const trimmed = raw.replace(/^\s+|\s+$/g, '')
  if (!trimmed) return null

  if (shouldDropStatement(trimmed)) return null

  // Split into code/string segments. Code segments get heavy rewriting;
  // string segments get escape normalization only.
  const segments = splitSegments(trimmed)

  // MySQL hex (`0xFF`), bit literals (`b'01'`, `0b01`), and `_binary`
  // prefixes only appear in VALUE positions in real-world dumps
  // (mysqldump). Applied globally they corrupt e.g. `CREATE TABLE t
  // (x INT DEFAULT 0x1)`. Restrict to INSERT/REPLACE statements.
  const allowHexBlob = /^(?:INSERT|REPLACE|UPDATE)\b/i.test(trimmed)

  const rewritten = segments.map((seg) => {
    if (seg.kind === 'string') return rewriteStringLiteral(seg.text)
    if (seg.kind === 'backtick') return rewriteBacktick(seg.text)
    return rewriteCode(seg.text, { allowHexBlob })
  })

  let stmt = rewritten.join('')

  // CREATE TABLE body rewriting must run after string/identifier rewriting
  // so regexes see double-quoted identifiers instead of backticks.
  if (/^\s*CREATE\s+TABLE\b/i.test(stmt)) {
    stmt = rewriteCreateTable(stmt)
  }

  return stmt.replace(/^\s+|\s+$/g, '') || null
}

function shouldDropStatement(stmt: string): boolean {
  const head = stmt.replace(/^\s*(?:\/\*[\s\S]*?\*\/\s*)*/, '')
  const patterns = [
    /^SET\b/i,
    /^USE\b/i,
    /^CREATE\s+DATABASE\b/i,
    /^DROP\s+DATABASE\b/i,
    /^CREATE\s+SCHEMA\b/i,
    /^DROP\s+SCHEMA\b/i,
    /^LOCK\s+TABLES?\b/i,
    /^UNLOCK\s+TABLES?\b/i,
    /^DELIMITER\b/i,
    /^SHOW\b/i,
    /^FLUSH\b/i,
    /^OPTIMIZE\s+TABLE\b/i,
    /^ANALYZE\s+TABLE\b/i,
    /^GRANT\b/i,
    /^REVOKE\b/i,
    /^CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?(?:TRIGGER|PROCEDURE|FUNCTION|VIEW|EVENT)\b/i,
    /^CREATE\s+ALGORITHM\s*=/i,
    /^START\s+TRANSACTION\b/i,
    /^REPLACE\s+INTO\b/i,
  ]
  return patterns.some((p) => p.test(head))
}

// --- Segment splitting ------------------------------------------------------

type Segment =
  | { kind: 'code'; text: string }
  | { kind: 'string'; text: string }
  | { kind: 'backtick'; text: string }

function splitSegments(s: string): Segment[] {
  const segments: Segment[] = []
  let i = 0
  const n = s.length
  let codeBuf = ''
  const flushCode = () => {
    if (codeBuf) {
      segments.push({ kind: 'code', text: codeBuf })
      codeBuf = ''
    }
  }
  while (i < n) {
    const ch = s[i]
    if (ch === "'" || ch === '"') {
      flushCode()
      const { consumed, text } = consumeQuoted(s, i, ch)
      segments.push({ kind: 'string', text })
      i += consumed
      continue
    }
    if (ch === '`') {
      flushCode()
      const { consumed, text } = consumeQuoted(s, i, '`')
      segments.push({ kind: 'backtick', text })
      i += consumed
      continue
    }
    codeBuf += ch
    i += 1
  }
  flushCode()
  return segments
}

// --- Segment rewriters ------------------------------------------------------

// Single- or double-quoted MySQL string literal. Normalize escapes to
// SQLite's dialect (only doubled-quote; no backslash escapes).
function rewriteStringLiteral(text: string): string {
  const quote = text[0] as "'" | '"'
  const body = text.slice(1, -1)
  let out = ''
  let i = 0
  while (i < body.length) {
    const ch = body[i]
    if (ch === '\\' && i + 1 < body.length) {
      const esc = body[i + 1]
      switch (esc) {
        case '0': out += '\x00'; break
        case "'": out += "''"; break
        case '"': out += quote === '"' ? '""' : '"'; break
        case 'b': out += '\b'; break
        case 'n': out += '\n'; break
        case 'r': out += '\r'; break
        case 't': out += '\t'; break
        case 'Z': out += '\x1A'; break
        case '\\': out += '\\'; break
        case '%': out += '\\%'; break
        case '_': out += '\\_'; break
        default: out += esc
      }
      i += 2
      continue
    }
    if (ch === quote && body[i + 1] === quote) {
      out += quote + quote
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return quote + out + quote
}

function rewriteBacktick(text: string): string {
  const body = text.slice(1, -1).replace(/``/g, '`')
  return '"' + body.replace(/"/g, '""') + '"'
}

function rewriteCode(text: string, opts: { allowHexBlob: boolean } = { allowHexBlob: false }): string {
  let s = text
  if (opts.allowHexBlob) {
    // Strip `_binary` prefix MySQL uses for binary literals.
    s = s.replace(/\b_binary\s+/gi, '')
    // MySQL `b'0101'` and `0b0101` bit literals → drop the prefix, keep value
    // as string. SQLite has no bit type; this isn't perfect but sheets don't
    // carry bit semantics.
    s = s.replace(/\bb'([01]+)'/g, "'$1'")
    s = s.replace(/\b0b([01]+)\b/g, "'$1'")
    // MySQL hex literals `0x...` → SQLite BLOB literal `x'...'`. Only safe
    // in value positions; mysqldump uses hex only for INSERT binary columns.
    s = s.replace(/\b0[xX]([0-9a-fA-F]+)\b/g, "x'$1'")
    // X'...' → x'...' (case normalization; sql.js accepts both but keep lower)
    s = s.replace(/\bX'([0-9a-fA-F]+)'/g, "x'$1'")
  }
  // MariaDB emits `current_timestamp()` with parens; SQLite only accepts
  // the bare keyword. Same for current_date/current_time. `now()` is a
  // MySQL/MariaDB alias with no SQLite equivalent function — map to the
  // keyword.
  s = s.replace(/\bcurrent_timestamp\s*\(\s*\)/gi, 'CURRENT_TIMESTAMP')
  s = s.replace(/\bcurrent_date\s*\(\s*\)/gi, 'CURRENT_DATE')
  s = s.replace(/\bcurrent_time\s*\(\s*\)/gi, 'CURRENT_TIME')
  s = s.replace(/\bnow\s*\(\s*\)/gi, 'CURRENT_TIMESTAMP')
  return s
}

// --- CREATE TABLE body -----------------------------------------------------

function rewriteCreateTable(stmt: string): string {
  // Find the outermost `(...)` block. The tokenizer already ensures strings
  // and identifiers are whole, so we can track paren depth on the naive
  // stmt safely as long as we skip inside quotes.
  const openIdx = findUnquotedChar(stmt, '(', 0)
  if (openIdx === -1) return stmt
  const closeIdx = findMatchingParen(stmt, openIdx)
  if (closeIdx === -1) return stmt

  const head = stmt.slice(0, openIdx + 1)
  const body = stmt.slice(openIdx + 1, closeIdx)
  // Strip everything between ) and end — ENGINE, AUTO_INCREMENT, etc.
  const tail = ')'

  const newBody = rewriteCreateTableBody(body)
  return head + newBody + tail
}

function rewriteCreateTableBody(body: string): string {
  // Split on top-level commas (ignore commas inside parens or quotes).
  const parts = splitTopLevelCommas(body)
  const out: string[] = []
  for (const raw of parts) {
    const part = raw.replace(/^\s+|\s+$/g, '')
    if (!part) continue
    const kept = rewriteCreateTablePart(part)
    if (kept !== null) out.push(kept)
  }
  return '\n  ' + out.join(',\n  ') + '\n'
}

function rewriteCreateTablePart(part: string): string | null {
  // Drop index-only clauses (no data impact).
  if (/^(?:FULLTEXT|SPATIAL)\s+(?:KEY|INDEX)\b/i.test(part)) return null
  if (/^(?:KEY|INDEX)\s/i.test(part)) return null
  if (/^CONSTRAINT\s+\S+\s+(?:KEY|INDEX)\b/i.test(part) &&
      !/FOREIGN\s+KEY/i.test(part) &&
      !/PRIMARY\s+KEY/i.test(part) &&
      !/UNIQUE/i.test(part)) {
    return null
  }

  // UNIQUE KEY name (...) → UNIQUE (...)
  let p = part.replace(/^UNIQUE\s+KEY\s+\S+\s*/i, 'UNIQUE ')
  // Also bare `UNIQUE INDEX name (...)`
  p = p.replace(/^UNIQUE\s+INDEX\s+\S+\s*/i, 'UNIQUE ')
  // CONSTRAINT name UNIQUE (...) → UNIQUE (...)  (simpler for SQLite)
  p = p.replace(/^CONSTRAINT\s+\S+\s+UNIQUE\b/i, 'UNIQUE')

  // Strip `USING BTREE|HASH` clauses anywhere.
  p = p.replace(/\s+USING\s+(?:BTREE|HASH)\b/gi, '')

  // Column-level attribute strips (don't affect data).
  p = p.replace(/\s+UNSIGNED\b/gi, '')
  p = p.replace(/\s+ZEROFILL\b/gi, '')
  p = p.replace(/\s+AUTO_INCREMENT\b/gi, '')
  p = p.replace(/\s+CHARACTER\s+SET\s+\S+/gi, '')
  p = p.replace(/\s+COLLATE\s+\S+/gi, '')
  p = p.replace(/\s+ON\s+UPDATE\s+CURRENT_TIMESTAMP(?:\s*\(\s*\))?/gi, '')
  p = p.replace(/\s+COMMENT\s+('[^']*'|"[^"]*")/gi, '')

  // Type remaps that SQLite would reject.
  p = p.replace(/\bENUM\s*\([^)]*\)/gi, 'TEXT')
  p = p.replace(/\bSET\s*\([^)]*\)/gi, 'TEXT')
  p = p.replace(/\b(?:TINY|MEDIUM|LONG)TEXT\b/gi, 'TEXT')
  p = p.replace(/\b(?:TINY|MEDIUM|LONG)BLOB\b/gi, 'BLOB')
  p = p.replace(/\bJSON\b/gi, 'TEXT')

  return p.replace(/^\s+|\s+$/g, '')
}

// --- Small string utilities ------------------------------------------------

function findUnquotedChar(s: string, ch: string, from: number): number {
  let i = from
  const n = s.length
  while (i < n) {
    const c = s[i]
    if (c === "'" || c === '"' || c === '`') {
      const { consumed } = consumeQuoted(s, i, c as "'" | '"' | '`')
      i += consumed
      continue
    }
    if (c === ch) return i
    i += 1
  }
  return -1
}

function findMatchingParen(s: string, openIdx: number): number {
  let depth = 1
  let i = openIdx + 1
  const n = s.length
  while (i < n) {
    const c = s[i]
    if (c === "'" || c === '"' || c === '`') {
      const { consumed } = consumeQuoted(s, i, c as "'" | '"' | '`')
      i += consumed
      continue
    }
    if (c === '(') depth += 1
    else if (c === ')') {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  return -1
}

function splitTopLevelCommas(s: string): string[] {
  const out: string[] = []
  let buf = ''
  let i = 0
  const n = s.length
  let depth = 0
  while (i < n) {
    const c = s[i]
    if (c === "'" || c === '"' || c === '`') {
      const { consumed, text } = consumeQuoted(s, i, c as "'" | '"' | '`')
      buf += text
      i += consumed
      continue
    }
    if (c === '(') { depth += 1; buf += c; i += 1; continue }
    if (c === ')') { depth -= 1; buf += c; i += 1; continue }
    if (c === ',' && depth === 0) {
      out.push(buf)
      buf = ''
      i += 1
      continue
    }
    buf += c
    i += 1
  }
  if (buf.length) out.push(buf)
  return out
}
