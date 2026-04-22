# SQL import

`src/importers/sql.ts` + `src/importers/sql-dialect.ts` handle both
`.sqlite` binary databases and `.sql` text dumps.

## Lazy sql.js

`sql.js` is loaded lazily via dynamic `import('sql.js')` + Vite
`?url` import of `sql-wasm.wasm`. A dropped CSV or XLSX must never
pay the ~1 MB WASM download. `sqljs.ts` memoizes the loader so
repeated SQL drops share the same WASM instance.

## Binary vs text dispatch

`detectFileKind` in `src/file-router.ts` reads the first 16 bytes
and sniffs magic:

- ZIP header (`PK\x03\x04`) → `xlsx`
- `"SQLite format 3\0"` → `sqlite`

Falls back to extension when there's no magic:

- `.sqlite` / `.db` / `.sqlite3` → `sqlite`
- `.sql` → `sql`
- otherwise `csv`

The magic sniff defeats renamed / extensionless files, which the
old extension-only path silently misrouted. SQL dumps have no
deterministic magic, so they stay extension-routed.

`importSql` branches on the kind:

- **dump**: run dialect normalization, then `db.exec(text)` with a
  50 000-statement cap (`MAX_SQL_STATEMENTS`).
- **binary**: `new SQL.Database(bytes)` directly.

## Table read-out

Runs `SELECT * FROM "<name>"` per table from `sqlite_master`
(excluding `sqlite_*` internal tables). The table name is
double-quoted with embedded-quote escaping — treat dropped DB files
as untrusted input. The column-name array is prepended as row 0 of
each sheet so the column schema survives the import.

## Dialect normalizer — lossy, not a migrator

**`sql-dialect.ts` is a lossy normalizer, not a migrator.** Its job
is to get row data into SQLite, not to faithfully translate MySQL
schemas. When in doubt between "drop a clause" and "try to
translate it," it drops.

Clauses currently dropped or rewritten:

### Statement-level (whole statements removed)

`SET`, `USE`, `CREATE DATABASE/SCHEMA`, `LOCK TABLES`, `DELIMITER`,
`CREATE TRIGGER/PROCEDURE/FUNCTION/VIEW/EVENT`, `GRANT`, `REVOKE`,
`SHOW`, `FLUSH`, `REPLACE INTO`, `START TRANSACTION`.

### Column / table options

`ENGINE=…`, `AUTO_INCREMENT=…`, `DEFAULT CHARSET=…`, `COLLATE …`,
`ROW_FORMAT=…`, `USING BTREE|HASH`, `UNSIGNED`, `ZEROFILL`,
`AUTO_INCREMENT` token, `CHARACTER SET …`,
`ON UPDATE CURRENT_TIMESTAMP`, `COMMENT '…'`,
`ENUM(…)` / `SET(…)` → `TEXT`,
`TINY/MEDIUM/LONGTEXT` → `TEXT`,
`TINY/MEDIUM/LONGBLOB` → `BLOB`,
`JSON` → `TEXT`.

### Index-only clauses inside CREATE TABLE

`KEY …`, `INDEX …`, `FULLTEXT`, `SPATIAL`.
`UNIQUE KEY name (cols)` → `UNIQUE (cols)`.

### Literal rewrites

- Backtick identifiers → `"..."`.
- MySQL string-escape sequences (`\'`, `\\`, `\n`, etc.) decoded to
  the actual character, then SQLite-safe doubled-single-quote
  escape for stored `'`.
- `0x…` hex literals → `x'…'`.
- `b'…'` / `0b…` bit literals → string.
- `_binary` prefix stripped.
- `current_timestamp()` / `now()` → `CURRENT_TIMESTAMP`.

## Idempotency

The normalizer is idempotent on clean SQLite dumps (no backticks,
no `ENGINE=`, no `KEY` clauses) so there's no "is this MySQL?"
branch — it always runs. `looksLikeMysql()` is exported for
diagnostics only.

## What's NOT handled (intentional gaps)

- PostgreSQL `pg_dump` output — different syntax entirely
  (sequences, `COPY`, `$$`-quoted bodies). Out of scope.
- Stored procedure / trigger / view bodies — dropped wholesale.
- MySQL `NO_BACKSLASH_ESCAPES` mode dumps — the normalizer assumes
  backslash escapes, which matches `mysqldump` defaults.

When extending the normalizer, always work inside the segment model
(`splitSegments`) so transformations don't corrupt string contents.
Every transformation must have a fixture-based test.
