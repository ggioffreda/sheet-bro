/**
 * Playwright globalSetup: regenerates the binary e2e fixtures from
 * sample.csv so the xlsx/sqlite/sql files always match the canonical
 * source. Runs once per test run, before any spec.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import writeXlsxFile from 'write-excel-file/node'
import initSqlJs from 'sql.js'
import Papa from 'papaparse'

const here = dirname(fileURLToPath(import.meta.url))

export default async function globalSetup(): Promise<void> {
  const csvText = readFileSync(resolve(here, 'sample.csv'), 'utf8')
  const parsed = Papa.parse<string[]>(csvText.trim(), { skipEmptyLines: true })
  const rows = parsed.data
  const header = rows[0]
  const dataRows = rows.slice(1)

  // --- sample.xlsx --------------------------------------------------------
  // 2D-array form: [[cell, cell], [cell, cell]] — each cell is a plain
  // primitive or a {value, type} object. Mirrors how exporters/xlsx.ts
  // uses write-excel-file so the fixture exercises the same code path.
  const xlsxRows = [
    header.map((h) => ({ value: h, type: String })),
    ...dataRows.map((row) => [
      { value: Number(row[0]), type: Number },
      { value: row[1], type: String },
      { value: Number(row[2]), type: Number },
      { value: Number(row[3]), type: Number },
    ]),
  ]
  await writeXlsxFile(xlsxRows, {
    filePath: resolve(here, 'sample.xlsx'),
    sheet: 'Items',
  })

  // --- features.xlsx — date cell + typed columns --------------------------
  // Used by e2e/xlsx-features.spec.ts to pin normalizeCell contracts when
  // the import arrives from a real xlsx file (happy-dom can't run
  // read-excel-file, so the xlsx unit suite is mocked). The Date column
  // is the main value-add here — the unit coercion rule
  // `normalizeCell(Date) → ISO-8601 string` has no direct coverage without
  // a real xlsx round-trip.
  const featureDate = new Date(Date.UTC(2026, 0, 15, 9, 30, 0))
  const featureRows = [
    [
      { value: 'region', type: String },
      { value: 'revenue', type: String },
      { value: 'reported_at', type: String },
    ],
    [
      { value: 'North', type: String },
      { value: 1000, type: Number },
      { value: featureDate, type: Date, format: 'yyyy-mm-dd' },
    ],
    [
      { value: 'South', type: String },
      { value: 2500, type: Number },
      { value: featureDate, type: Date, format: 'yyyy-mm-dd' },
    ],
  ]
  await writeXlsxFile(featureRows, {
    filePath: resolve(here, 'features.xlsx'),
    sheet: 'Features',
  })

  // --- sample.sqlite + sample.sql ----------------------------------------
  const nodeRequire = createRequire(import.meta.url)
  const wasmBuffer = readFileSync(nodeRequire.resolve('sql.js/dist/sql-wasm.wasm'))
  const SQL = await initSqlJs({
    wasmBinary: wasmBuffer.buffer.slice(
      wasmBuffer.byteOffset,
      wasmBuffer.byteOffset + wasmBuffer.byteLength,
    ),
  })
  const db = new SQL.Database()
  // Two tables so multi-sheet round-trip specs have something to assert.
  db.exec(`
    CREATE TABLE items (id INTEGER, name TEXT, qty INTEGER, price REAL);
    CREATE TABLE tags (item_id INTEGER, tag TEXT);
    INSERT INTO tags VALUES (1, 'fruit'), (2, 'fruit'), (3, 'yellow'), (4, 'tropical');
  `)
  const stmt = db.prepare('INSERT INTO items VALUES (?, ?, ?, ?)')
  try {
    for (const row of dataRows) {
      stmt.run([Number(row[0]), row[1], Number(row[2]), Number(row[3])])
    }
  } finally {
    stmt.free()
  }
  const bytes = db.export()
  writeFileSync(resolve(here, 'sample.sqlite'), bytes)

  // Dump to SQL text
  const dumpLines: string[] = [
    'BEGIN TRANSACTION;',
    'CREATE TABLE items (id INTEGER, name TEXT, qty INTEGER, price REAL);',
    'CREATE TABLE tags (item_id INTEGER, tag TEXT);',
  ]
  for (const row of dataRows) {
    dumpLines.push(
      `INSERT INTO items VALUES (${row[0]}, '${row[1]}', ${row[2]}, ${row[3]});`,
    )
  }
  dumpLines.push(
    `INSERT INTO tags VALUES (1, 'fruit');`,
    `INSERT INTO tags VALUES (2, 'fruit');`,
    `INSERT INTO tags VALUES (3, 'yellow');`,
    `INSERT INTO tags VALUES (4, 'tropical');`,
    'COMMIT;',
  )
  writeFileSync(resolve(here, 'sample.sql'), dumpLines.join('\n') + '\n')

  db.close()
}
