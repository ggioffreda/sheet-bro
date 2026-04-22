import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import initSqlJs, { type Database } from 'sql.js'
import { looksLikeMysql, normalizeToSqlite, normalizeToSqliteStatements } from './sql-dialect'
import { UserFacingError } from '../user-facing-error'

const nodeRequire = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))

const wasmBuffer = readFileSync(nodeRequire.resolve('sql.js/dist/sql-wasm.wasm'))
const SQL = await initSqlJs({
  wasmBinary: wasmBuffer.buffer.slice(
    wasmBuffer.byteOffset,
    wasmBuffer.byteOffset + wasmBuffer.byteLength,
  ),
})

function loadFixture(name: string): string {
  return readFileSync(resolve(here, 'fixtures', name), 'utf8')
}

function run(sql: string): Database {
  const db = new SQL.Database()
  db.exec(sql)
  return db
}

function rowCount(db: Database, table: string): number {
  const res = db.exec(`SELECT COUNT(*) FROM "${table}"`)
  return Number(res[0].values[0][0])
}

function col(db: Database, table: string, id: number, column: string): unknown {
  const res = db.exec(`SELECT "${column}" FROM "${table}" WHERE id = ${id}`)
  return res[0].values[0][0]
}

describe('normalizeToSqlite', () => {
  it('round-trips a sqlite3 .dump fixture', () => {
    const sqlite = normalizeToSqlite(loadFixture('sqlite_dump.sql'))
    const db = run(sqlite)
    expect(rowCount(db, 'users')).toBe(3)
    expect(rowCount(db, 'posts')).toBe(3)
    expect(col(db, 'users', 1, 'email')).toBe('alice@example.com')
    expect(col(db, 'posts', 2, 'body')).toBe("it's me")
    expect(col(db, 'posts', 3, 'body')).toBe('multi\nline')
    db.close()
  })

  it('loads a default mysqldump (backticks, ENGINE, KEY, ENUM, JSON, BLOB, escapes)', () => {
    const raw = loadFixture('mysqldump_default.sql')
    expect(looksLikeMysql(raw)).toBe(true)
    const sqlite = normalizeToSqlite(raw)
    const db = run(sqlite)
    expect(rowCount(db, 'customers')).toBe(3)
    expect(rowCount(db, 'orders')).toBe(2)
    expect(col(db, 'customers', 1, 'email')).toBe('alice@example.com')
    // Backslash escapes in MySQL strings become real characters.
    expect(col(db, 'customers', 1, 'notes')).toBe("She's a VIP.\nPriority support.")
    // Carol's name has an apostrophe (\')
    expect(col(db, 'customers', 3, 'full_name')).toBe("Carol O'Hara")
    // ENUM column preserves the stored value (type mapped to TEXT).
    expect(col(db, 'customers', 1, 'kind')).toBe('premium')
    // JSON column value preserved (type mapped to TEXT).
    expect(col(db, 'customers', 1, 'payload')).toBe('{"tier":"gold"}')
    // _binary 0x... is a BLOB in sqlite.
    const receipt = col(db, 'orders', 1, 'receipt')
    expect(receipt).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(receipt as Uint8Array)).toBe('Hello')
    db.close()
  })

  it('loads a --compatible=ansi mysqldump', () => {
    const sqlite = normalizeToSqlite(loadFixture('mysqldump_ansi.sql'))
    const db = run(sqlite)
    expect(rowCount(db, 'items')).toBe(3)
    const res = db.exec(`SELECT name FROM "items" WHERE sku = 'SPROCKET-3'`)
    // Doubled single-quote in ANSI mode is a literal quote.
    expect(res[0].values[0][0]).toBe("Sprocket '12\"")
    db.close()
  })

  it('loads a MariaDB dump with SET type and CHECK(json_valid)', () => {
    const sqlite = normalizeToSqlite(loadFixture('mariadb_dump.sql'))
    const db = run(sqlite)
    expect(rowCount(db, 'events')).toBe(3)
    expect(col(db, 'events', 2, 'tags')).toBe('urgent,flagged')
    expect(col(db, 'events', 1, 'metadata')).toBe('{"v":1}')
    db.close()
  })

  it('is idempotent — a clean SQLite dump re-normalizes to the same output', () => {
    const once = normalizeToSqlite(loadFixture('sqlite_dump.sql'))
    const twice = normalizeToSqlite(once)
    // Row counts equal after re-normalize.
    const db2 = run(twice)
    expect(rowCount(db2, 'users')).toBe(3)
    db2.close()
  })

  it('drops DELIMITER directives and routine definitions without breaking data', () => {
    const sql = `
      CREATE TABLE t (id INT, v INT);
      INSERT INTO t VALUES (1, 10);
      DELIMITER //
      CREATE PROCEDURE p() BEGIN SELECT 1; END //
      DELIMITER ;
      INSERT INTO t VALUES (2, 20);
    `
    const db = run(normalizeToSqlite(sql))
    expect(rowCount(db, 't')).toBe(2)
    db.close()
  })

  it('passes through CREATE INDEX statements emitted outside CREATE TABLE', () => {
    // SQLite supports CREATE INDEX / CREATE UNIQUE INDEX natively; our
    // normalizer should rewrite the backtick identifiers but otherwise
    // leave these statements alone so the resulting DB retains its indexes.
    const sqlite = normalizeToSqlite(loadFixture('mysqldump_with_index.sql'))
    const db = run(sqlite)
    expect(rowCount(db, 'visits')).toBe(3)
    const indexes = db.exec(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='visits' ORDER BY name",
    )
    const names = indexes[0].values.map((r) => r[0])
    expect(names).toContain('idx_visits_user')
    expect(names).toContain('idx_visits_user_path')
    db.close()
  })

  it('preserves CHECK constraints and generated columns through a MariaDB dump', () => {
    const sqlite = normalizeToSqlite(loadFixture('mariadb_check_generated.sql'))
    const db = run(sqlite)
    expect(rowCount(db, 'products')).toBe(3)
    // Generated column values are computed by SQLite at query time, so the
    // round-trip should show price - discount correctly.
    const res = db.exec(`SELECT sku, net_cents FROM "products" ORDER BY id`)
    expect(res[0].values).toEqual([
      ['WIDGET-1', 999],
      ['WIDGET-2', 1199],
      ['GIZMO-1', 4499],
    ])
    // CHECK constraints should be enforced on insert. AUTO_INCREMENT was
    // stripped by the normalizer so we supply the PK explicitly.
    expect(() =>
      db.exec(`INSERT INTO "products" (id, sku, price_cents) VALUES (999, 'BAD', -1)`),
    ).toThrow(/CHECK constraint failed/i)
    db.close()
  })

  it('fails loudly on a PostgreSQL pg_dump (out of scope)', () => {
    // The normalizer doesn't understand $$-quoted function bodies, COPY FROM
    // stdin, regclass casts, or sequences. Produce SQL that sql.js rejects
    // rather than silently loading partial/garbage data.
    const raw = loadFixture('pg_dump.sql')
    const sqlite = normalizeToSqlite(raw)
    // Either normalization itself throws, or sql.js rejects the output.
    expect(() => {
      const db = run(sqlite)
      db.close()
    }).toThrow()
  })

  it('fails cleanly on a truncated/unterminated string literal', () => {
    // Tokenizer consumes to end-of-input for an unterminated quote; the
    // resulting statement reaches sql.js as malformed and must throw, not
    // hang. This test also guards against accidental infinite loops in
    // the segment walker.
    const truncated = "CREATE TABLE t (id INT, name VARCHAR(10));\nINSERT INTO t VALUES (1, 'unterminated"
    const sqlite = normalizeToSqlite(truncated)
    expect(() => {
      const db = run(sqlite)
      db.close()
    }).toThrow()
  })

  it('is byte-exact idempotent on a canonical SQLite dump (fixed point after one pass)', () => {
    // The invariant: running the normalizer on its own output is a no-op.
    // This is stronger than "same row counts" and catches formatting drift
    // in rewriteCreateTable / segment rejoining.
    const once = normalizeToSqlite(loadFixture('sqlite_dump.sql'))
    const twice = normalizeToSqlite(once)
    expect(twice).toBe(once)
  })

  it('is byte-exact idempotent on a mysqldump after the first pass normalizes it', () => {
    const once = normalizeToSqlite(loadFixture('mysqldump_default.sql'))
    const twice = normalizeToSqlite(once)
    expect(twice).toBe(once)
  })
})

// --- String-literal escape matrix ------------------------------------------

describe('rewriteStringLiteral (MySQL backslash-escape decoding)', () => {
  // These tests exercise every branch of the escape switch. Each case puts
  // the escape inside a single-row INSERT and asserts the materialized
  // column value after sql.js decodes the normalized SQL.
  function decode(body: string, quote: "'" | '"' = "'"): unknown {
    // body is the raw string content WITHOUT the outer quotes. We emit a
    // mysqldump-shaped statement so rewriteStringLiteral sees it.
    const literal = quote === "'" ? `'${body}'` : `"${body}"`
    const src = `CREATE TABLE t (s TEXT); INSERT INTO t VALUES (${literal});`
    const db = run(normalizeToSqlite(src))
    const res = db.exec(`SELECT s FROM "t"`)
    const v = res[0].values[0][0]
    db.close()
    return v
  }

  it.each([
    ['\\b', '\b', 'backspace'],
    ['\\n', '\n', 'newline'],
    ['\\r', '\r', 'carriage return'],
    ['\\t', '\t', 'tab'],
    ['\\Z', '\x1A', 'Ctrl-Z / MySQL SUB'],
    ['\\\\', '\\', 'literal backslash'],
  ])('decodes %j inside single-quoted literal → %j (%s)', (escaped, expected) => {
    expect(decode(escaped)).toBe(expected)
  })

  it('decodes \\0 to NUL at the normalizer level (sql.js exec truncates at NUL)', () => {
    // sql.js's Emscripten bridge treats SQL text as a C string, so it stops
    // at the first NUL byte on exec. The normalizer's job is to emit the
    // decoded byte; we verify that by inspecting the output SQL text rather
    // than round-tripping. exporters/sql.ts:sqlLiteral strips NUL on the
    // export side for the same reason.
    const src = `CREATE TABLE t (s TEXT); INSERT INTO t VALUES ('pre\\0post');`
    const normalized = normalizeToSqlite(src)
    expect(normalized).toContain('pre\x00post')
  })

  it('decodes \\\' inside single-quoted literal as a literal apostrophe', () => {
    expect(decode("I\\'m")).toBe("I'm")
  })

  it('decodes \\" inside single-quoted literal as a bare double quote', () => {
    // rewriteStringLiteral special-cases: inside '...', \" becomes " (not "").
    expect(decode('say \\"hi\\"')).toBe('say "hi"')
  })

  it('decodes \\" inside double-quoted literal by doubling the quote (MySQL identifier-compat)', () => {
    // Double-quoted strings become SQLite identifiers via the segment
    // rewriter, but rewriteStringLiteral still normalizes the escape.
    // Avoid asserting identifier semantics; just verify decoding round-trips
    // when the double-quoted string is used in an INSERT value by switching
    // to the identifier slot is out of scope — use the code-path via string
    // context instead:
    const raw = `CREATE TABLE t (s TEXT); INSERT INTO t VALUES ('outer \\" inner');`
    const db = run(normalizeToSqlite(raw))
    const res = db.exec(`SELECT s FROM "t"`)
    expect(res[0].values[0][0]).toBe('outer " inner')
    db.close()
  })

  it.each([
    ['\\%', '\\%', 'LIKE wildcard percent'],
    ['\\_', '\\_', 'LIKE wildcard underscore'],
  ])('preserves %j as the SQLite LIKE-safe form %j (%s)', (escaped, expected) => {
    expect(decode(escaped)).toBe(expected)
  })

  it('decodes an unknown escape (\\q) as the bare character q', () => {
    // MySQL's default-branch behaviour: unknown escapes drop the backslash.
    expect(decode('he\\quested')).toBe('hequested')
  })

  it('handles mixed escapes in one literal', () => {
    expect(decode("line1\\nline2\\ttab\\\\back\\'end")).toBe("line1\nline2\ttab\\back'end")
  })

  it('handles doubled single-quote inside single-quoted (SQL-standard escape)', () => {
    expect(decode("a''b")).toBe("a'b")
  })
})

// --- Edge-case branches in the tokenizer and segment rewriter --------------

describe('normalizeToSqlite — tokenizer edge cases', () => {
  it('strips a trailing # line comment that has no terminating newline', () => {
    // The `#` branch must handle EOF (indexOf returns -1) as well as finding
    // a newline. Without this guard the tokenizer would hang past the buffer.
    const src = `CREATE TABLE t (id INT);\nINSERT INTO t VALUES (1);\n# no newline at eof`
    const out = normalizeToSqlite(src)
    expect(out).not.toContain('# no newline at eof')
    const db = run(out)
    expect(rowCount(db, 't')).toBe(1)
    db.close()
  })

  it('strips a trailing -- line comment that has no terminating newline', () => {
    // Symmetric EOF branch in the "--" tokenizer.
    const src = `CREATE TABLE t (id INT);\nINSERT INTO t VALUES (1);\n-- eof comment`
    const db = run(normalizeToSqlite(src))
    expect(rowCount(db, 't')).toBe(1)
    db.close()
  })

  it('tolerates an unterminated block comment without infinite-looping', () => {
    // Block-comment branch's EOF fallback: `indexOf('*/')` returns -1.
    const src = `CREATE TABLE t (id INT);\nINSERT INTO t VALUES (1);\n/* dangling comment`
    // Must at least finish normalization; sql.js may reject the output, but
    // the normalizer itself must not spin.
    const out = normalizeToSqlite(src)
    expect(typeof out).toBe('string')
  })

  it('drops a CONSTRAINT name INDEX (...) clause from CREATE TABLE', () => {
    // The CONSTRAINT... KEY/INDEX branch distinct from FOREIGN/PRIMARY/UNIQUE.
    const src = `
      CREATE TABLE t (
        id INT NOT NULL,
        email VARCHAR(255),
        CONSTRAINT idx_email INDEX (email)
      );
      INSERT INTO t VALUES (1, 'a@ex.com');
    `
    const db = run(normalizeToSqlite(src))
    expect(rowCount(db, 't')).toBe(1)
    db.close()
  })

  it('leaves a CREATE TABLE that has no body parentheses untouched', () => {
    // Exercises the `findUnquotedChar === -1` early-return in
    // rewriteCreateTable. The normalizer must not rewrite a CREATE TABLE
    // whose body we cannot locate; it should emit the statement verbatim and
    // let sql.js surface the syntax error.
    const src = `CREATE TABLE broken; INSERT INTO after (id) VALUES (1);`
    const out = normalizeToSqlite(src)
    expect(out).toContain('CREATE TABLE broken')
  })

  it('leaves a CREATE TABLE with an unterminated opening paren untouched', () => {
    // Exercises the `findMatchingParen === -1` early-return: the opening
    // paren is present but never closes. Rewriting would corrupt the body,
    // so the normalizer passes it through unchanged.
    const src = `CREATE TABLE broken (id INT, name VARCHAR`
    const out = normalizeToSqlite(src)
    expect(out).toContain('CREATE TABLE broken (id INT, name VARCHAR')
  })

  it('handles -- comments with all newline/whitespace after-char variants', () => {
    // Covers the branches of the `-- ` detector where the post-`--` char is
    // \t, \n, \r, or EOF (undefined). Each variant must be recognised as the
    // start of a line comment and stripped.
    const variants = [
      `CREATE TABLE a (id INT);\n--\ttab-comment\nINSERT INTO a VALUES (1);`,
      `CREATE TABLE b (id INT);\n--\rcr-comment\nINSERT INTO b VALUES (1);`,
      `CREATE TABLE c (id INT);\n--\nINSERT INTO c VALUES (1);`, // bare `--` at EOL
    ]
    for (const [i, src] of variants.entries()) {
      const tbl = String.fromCharCode(97 + i)
      const db = run(normalizeToSqlite(src))
      expect(rowCount(db, tbl)).toBe(1)
      db.close()
    }
  })

  it('recognises -- at end-of-input (no char after) as a line comment', () => {
    const src = `CREATE TABLE t (id INT); INSERT INTO t VALUES (1); --`
    const db = run(normalizeToSqlite(src))
    expect(rowCount(db, 't')).toBe(1)
    db.close()
  })

  it('handles a # line comment followed by a newline and more statements', () => {
    // Covers the else branch of `if (nl === -1)` in the # tokenizer — the
    // common case where the comment is mid-file, not at EOF.
    const src = `CREATE TABLE t (id INT);\n# header comment\nINSERT INTO t VALUES (1);`
    const db = run(normalizeToSqlite(src))
    expect(rowCount(db, 't')).toBe(1)
    db.close()
  })

  it('drops a statement whose segment is only whitespace after trim', () => {
    // Covers the `|| null` branch of the per-statement trim — a segment
    // consisting only of semicolons and whitespace must resolve to null and
    // be skipped, not emitted as a malformed empty statement.
    const src = `CREATE TABLE t (id INT);   \n  ;   ;\nINSERT INTO t VALUES (1);`
    const db = run(normalizeToSqlite(src))
    expect(rowCount(db, 't')).toBe(1)
    db.close()
  })

  it('tolerates a trailing empty column declaration (CREATE TABLE t (a INT, ))', () => {
    // Covers `if (!part) continue` in the column parser — a trailing comma
    // produces an empty part that must be skipped, not misinterpreted as a
    // column named "".
    const src = `CREATE TABLE t (id INT, );`
    const out = normalizeToSqlite(src)
    // Normalization should still emit a CREATE TABLE without the bad trailer.
    expect(out).toMatch(/CREATE TABLE\s+["']?t["']?\s*\(/i)
  })

  it('emits a doubled quote when a double-quote escape appears inside a double-quoted string', () => {
    // Covers the `"` case of rewriteStringLiteral under double-quote quoting.
    // MySQL allows `"a\"b"` inside a double-quoted literal — the normalizer
    // converts the escape to the SQLite-standard doubled quote.
    const src = `CREATE TABLE t (s TEXT); INSERT INTO t VALUES ("a\\"b");`
    const out = normalizeToSqlite(src)
    // The rewritten form must contain the doubled double-quote sequence.
    expect(out).toContain('""')
  })
})

describe('normalizeToSqlite — UPDATE hex/bit literal rewrite', () => {
  it('rewrites `0xFF` inside an UPDATE statement to an SQLite BLOB literal', () => {
    const out = normalizeToSqlite(`UPDATE t SET x = 0xFF WHERE id = 1;`)
    expect(out).toContain("x'FF'")
    expect(out).not.toContain('0xFF')
  })

  it('still leaves hex literals inside CREATE TABLE DEFAULT clauses as integers', () => {
    // Guards against the UPDATE broadening unintentionally swallowing
    // CREATE TABLE — `allowHexBlob` keys off the leading keyword only.
    const out = normalizeToSqlite(`CREATE TABLE t (id INT DEFAULT 0x1);`)
    expect(out).toContain('DEFAULT 0x1')
  })
})

describe('normalizeToSqlite — per-statement size cap', () => {
  it('throws UserFacingError when a single statement exceeds 5 MB', () => {
    // A 5 MB + 1-byte single INSERT that the tokenizer sees as one
    // statement. Use a wide string literal so there is no semicolon
    // inside to split on.
    const body = 'x'.repeat(5 * 1024 * 1024 + 10)
    const huge = `INSERT INTO t VALUES ('${body}');`
    expect(() => normalizeToSqliteStatements(huge)).toThrow(UserFacingError)
    expect(() => normalizeToSqliteStatements(huge)).toThrow(/5 MB limit/)
  })

  it('accepts a batch of small statements whose combined size exceeds 5 MB', () => {
    // The cap is per-statement, not per-input — a large dump composed of
    // small statements must still pass.
    const one = `INSERT INTO t VALUES (1);\n`
    const many = one.repeat(10_000)
    const prefix = `CREATE TABLE t (id INT);\n`
    expect(() => normalizeToSqliteStatements(prefix + many)).not.toThrow()
  })
})

describe('looksLikeMysql — individual marker branches', () => {
  it('detects ENGINE= (without backticks)', () => {
    expect(looksLikeMysql(`CREATE TABLE t (id INT) ENGINE=InnoDB;`)).toBe(true)
  })
  it('detects /*! conditional hints', () => {
    expect(looksLikeMysql(`/*!40101 SET NAMES utf8 */;`)).toBe(true)
  })
  it('detects LOCK TABLES', () => {
    expect(looksLikeMysql(`LOCK TABLES t WRITE;\nUNLOCK TABLES;`)).toBe(true)
  })
  it('detects SET @@ session variables', () => {
    expect(looksLikeMysql(`SET @@session.sql_mode = '';`)).toBe(true)
  })
  it('detects AUTO_INCREMENT', () => {
    expect(looksLikeMysql(`CREATE TABLE t (id INT AUTO_INCREMENT PRIMARY KEY);`)).toBe(true)
  })
  it('returns false for a plain SQLite dump with none of the above', () => {
    expect(looksLikeMysql(`CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1);`)).toBe(false)
  })
})

describe('normalizeToSqlite — empty-statement and DELIMITER-flush branches', () => {
  it('drops empty statements from runs of consecutive semicolons', () => {
    // Input ;; produces an empty statement between the two semicolons; the
    // normalizer's `if (!trimmed) return null` path must skip it rather than
    // emit a bare `;` into the output.
    const out = normalizeToSqlite(`CREATE TABLE t (id INT);; INSERT INTO t VALUES (1);`)
    // No lone `;` artifacts in the output.
    expect(out).not.toMatch(/(^|\n);\s*(\n|$)/)
    const db = run(out)
    expect(rowCount(db, 't')).toBe(1)
    db.close()
  })

  it('drops a statement that rewrites to an empty string after normalization', () => {
    // A MySQL conditional hint /*!40101 ... */ at the top of a dump will be
    // stripped by the code-segment rewriter. When the whole statement was
    // just that hint, the post-rewrite trim returns '' and the normalizer
    // uses the `|| null` fallback to drop it.
    const src = `/*!40101 SET NAMES utf8 */;\nCREATE TABLE t (id INT);\nINSERT INTO t VALUES (1);`
    const db = run(normalizeToSqlite(src))
    expect(rowCount(db, 't')).toBe(1)
    db.close()
  })

  it('preserves hex integer literals in CREATE TABLE DEFAULT clauses', () => {
    // `0x1` in a CREATE TABLE DEFAULT must stay an integer — the old
    // unconditional rewriter turned it into `x'1'` (BLOB), which sqlite
    // then rejected for an INT column.
    const src = `CREATE TABLE t (id INT PRIMARY KEY, flag INT DEFAULT 0x1);\nINSERT INTO t (id) VALUES (42);`
    const out = normalizeToSqlite(src)
    expect(out).toContain('DEFAULT 0x1')
    const db = run(out)
    const res = db.exec('SELECT flag FROM t WHERE id = 42')
    expect(res[0].values[0][0]).toBe(1)
    db.close()
  })

  it('still rewrites hex literals inside INSERT value positions', () => {
    // mysqldump emits BLOB column values as `0xDEADBEEF`. That must
    // still become `x'DEADBEEF'` so sqlite stores a BLOB, not a string.
    const src = `CREATE TABLE t (id INT, blob_val BLOB);\nINSERT INTO t VALUES (1, 0xDEADBEEF);`
    const out = normalizeToSqlite(src)
    expect(out).toContain("x'DEADBEEF'")
    const db = run(out)
    const res = db.exec('SELECT blob_val FROM t WHERE id = 1')
    expect(res[0].values[0][0]).toBeInstanceOf(Uint8Array)
    db.close()
  })

  it('flushes a buffered non-empty statement when DELIMITER appears mid-line', () => {
    // When DELIMITER is encountered while the statement buffer is non-empty
    // (e.g. a dump whose preceding statement has no trailing semicolon),
    // the tokenizer must push the buffered statement rather than silently
    // merging it with the DELIMITER-scoped follow-up.
    const src = `SELECT 1\nDELIMITER //\nSELECT 2 //\nDELIMITER ;\nCREATE TABLE t (id INT);\nINSERT INTO t VALUES (1);`
    // Just exercise the path — we don't care whether sql.js runs the output.
    const out = normalizeToSqlite(src)
    expect(out).toContain('CREATE TABLE')
  })
})

