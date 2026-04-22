# Exporters

## Shape

`src/exporters/shared.ts` is the pure core: sanitization, header
detection, type inference, coercion, and the `TableSpec` model. The
four format-specific exporters (`csv.ts`, `xlsx.ts`, `sql.ts`,
`sqlite.ts`) are thin shells on top. `safe-export.ts` wraps each of
them in a password-encrypted ZIP.

Shared model:

```ts
type ColumnType = 'INTEGER' | 'REAL' | 'TEXT'
type ColumnSpec = { name: string; type: ColumnType }
type TableSpec = {
  tableName: string
  columns: ColumnSpec[]
  rows: ExportCell[][]
  usedGeneratedHeader: boolean  // true when row 0 wasn't a usable header
}
```

## Cell coercion (import side, for context)

`src/cell.ts::normalizeCell` is the single funnel into Univer's
cell value type (`string | number`):

- `Date` → ISO string
- `boolean` → `'TRUE' | 'FALSE'`
- `Uint8Array` → `'[BLOB: N bytes]'`
- `null` / `undefined` → `''`

CSV path: `coerceCsvCell` converts numeric-looking strings to
`Number`; empty strings stay empty. XLSX path: cells arrive typed
(`string | number | boolean | Date | null`). SQL path: cells arrive
`string | number | Uint8Array | null`.

If you change a coercion, check the matching one on the export
side — symmetry between import and export matters for round-tripping.

## Always-quote identifier policy

Every table and column name is sanitized to `[A-Za-z_][A-Za-z0-9_]*`
(63-char cap, NFKD-normalized) **AND** emitted inside `"..."` with
`"` escaped as `""`. Reserved words (`order`, `group`) stay safe
without a keyword list. MySQL/MariaDB users need
`sql_mode=ANSI_QUOTES` to consume the text export — noted in README.

## Header-row heuristic (`isHeaderRow`)

Row 0 is a header iff every cell is a non-empty string whose first
non-space character is not a digit or `+`/`-`. This biases toward
"not a header" to protect data rows from being mislabeled as column
names. False negatives lose a row of readability; false positives
corrupt data — the bias matters. When the heuristic rejects row 0,
columns get `col1..colN` names and `usedGeneratedHeader` is set;
the post-export toast surfaces how many tables fell back.

## Column-type inference (`inferColumnType`)

Per column, each cell classifies as integer / real / text / null.
**Any `text` classification locks the column to TEXT** — no
majority vote. Key gates that push to TEXT:

- leading-zero strings (`007`)
- thousands separators (`1,000`)
- integer strings longer than 15 digits (JS `Number` precision)
- booleans
- non-finite numbers

The 15-digit cap is deliberate: sql.js returns SQLite integers as
JS `number`, so a 19-digit column would silently lose precision on
re-import.

## SQL text output (`buildSqlText`)

500-row batched `INSERT INTO "t" VALUES (...), (...);` statements
wrapped in `BEGIN TRANSACTION; ... COMMIT;`. No backslash escapes
in strings (SQLite doesn't honor them by default); `'` doubles to
`''`. Booleans serialize as `1`/`0` (consistency with sql.js
bindings). NUL bytes are stripped — many SQL clients choke on them
in TEXT.

## SQLite binary output (`buildDbBytes`)

`sql.js` prepared statements inside a `BEGIN`/`COMMIT` transaction.
Without the transaction, every INSERT auto-commits and a large
sheet crawls. `db.export()` returns the `.sqlite` file bytes.
`sqljs.ts` memoizes the WASM load across repeated exports.

## Univer-agnostic purity rule

**Exporters MUST stay Univer-agnostic in their pure parts.**
`buildSqlText` and `buildDbBytes` take plain `TableSpec[]` and have
no Univer dependency — this is what lets `sql.test.ts` round-trip
them against sql.js directly, without mocking a workbook. Only the
top-level `exportSql(api)` / `exportSqlite(api)` / `buildCsvExport`
/ `buildXlsxExport` wrappers touch Univer.

## Safe Export — encrypted ZIP wrapper

`src/exporters/safe-export.ts` wraps each of the four formats in an
AES-encrypted ZIP via `@zip.js/zip.js`:

```ts
new ZipWriter(new BlobWriter('application/zip'),
              { password, encryptionStrength: 3 })
```

`encryptionStrength: 3` is AES-256 in the zip.js scheme. The
password comes from an in-app modal (`promptPassword` in
`app.ts`). The four `safeExportCsv` / `safeExportXlsx` /
`safeExportSql` / `safeExportSqlite` functions share a single
`encryptedZip(innerFilename, bytes, password)` helper and download
via `downloadBlob`.

Ribbon registration is in `src/app.ts:427-434`; the submenu is
labelled **Safe Export** under the File tab. See `docs/ribbon.md`
for how the menu is wired.

The inner file keeps its normal filename; the download filename is
`<filename>.zip`.
