import { createUniver, LocaleType, mergeLocales } from '@univerjs/presets'
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core'
import { UniverSheetsFilterPreset } from '@univerjs/preset-sheets-filter'
import UniverPresetSheetsCoreEnUS from '@univerjs/preset-sheets-core/locales/en-US'
import UniverPresetSheetsFilterEnUS from '@univerjs/preset-sheets-filter/locales/en-US'
import '@univerjs/preset-sheets-core/lib/index.css'
import '@univerjs/preset-sheets-filter/lib/index.css'
import { clearAllRecords, clearTabIdentity, closeStorage, deleteRecord, initStorage, initTabName, loadSnapshot, pruneStaleTabRegistry, saveSnapshot, setTabName, type StorageContext } from './persistence'
import { fileBasedTabName, readAllTabRegistry, removeTabRegistry, TAB_REGISTRY_PREFIX, toTabRegistryEntry, writeTabRegistry } from './tab-names'
import { buildAffectedTabLabels, collectAffectedTabs } from './affected-tabs'
import { type LoadedSheet, importXlsx, parseCsvText } from './importers'
import ParserWorker from './workers/parser.worker?worker'
import type { WorkerJob, WorkerResult } from './workers/parser.worker'
import { exportCsv, exportSql, exportSqlite, exportXlsx, safeExportCsv, safeExportSql, safeExportSqlite, safeExportXlsx } from './exporters'
import type { SqlExportResult, SqliteExportResult } from './exporters'
import { detectFileKind, labelForKind } from './file-router'
import { buildWorkbookShape } from './workbook-shape'
import { isPersistedSnapshot } from './snapshot-shape'
import { toUserMessage, UserFacingError } from './user-facing-error'

type UniverInstance = ReturnType<typeof createUniver>
type UniverAPI = UniverInstance['univerAPI']

const PERSIST_DEBOUNCE_MS = 400
const SHEETBRO_CHANNEL = new BroadcastChannel('sheet-bro-events')
// Pre-decompression cap. A 50 MB XLSX (ZIP) can inflate to many times
// that in memory during parse — this guard is about dropping obviously
// hostile files, not about bounding parsed-memory footprint. Streaming
// parsers would be the proper fix for that; out of scope for now.
export const MAX_FILE_BYTES = 50 * 1024 * 1024 // 50 MB
const NOTIFY_TIMEOUT_MS = 5000
// Hard wall on how long a single import may run. Catches decompression
// bombs and pathological files before they can stall the tab indefinitely.
// Under VITE_E2E only, a `?importTimeoutMs=N` query param overrides the
// default so Playwright can exercise the guard in a few hundred ms rather
// than waiting 30 s. Production bundles strip the override entirely.
const IMPORT_TIMEOUT_MS = readE2EImportTimeoutOverride() ?? 30_000

function readE2EImportTimeoutOverride(): number | null {
  if (!import.meta.env.VITE_E2E) return null
  try {
    const v = new URLSearchParams(window.location.search).get('importTimeoutMs')
    if (!v) return null
    const n = parseInt(v, 10)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

let univer: UniverInstance['univer'] | null = null
let univerAPI: UniverAPI | null = null
let storage: StorageContext | null = null
let persistTimer: number | null = null
let commandListener: { dispose: () => void } | null = null

const openTabRegistry = new Map<string, string>() // tabId → name

let emptyStateEl: HTMLElement | null = null
let dragOverlayEl: HTMLElement | null = null
let dragIdleTimer: number | null = null
let notifyEl: HTMLElement | null = null
let notifyTimer: number | null = null
let progressEl: HTMLElement | null = null
let progressTimer: number | null = null
let progressValue = 0
let passwordDialogEl: HTMLElement | null = null
let passwordTitleEl: HTMLElement | null = null
let passwordInputEl: HTMLInputElement | null = null
let passwordConfirmEl: HTMLInputElement | null = null
let passwordErrorEl: HTMLElement | null = null
let passwordCancelEl: HTMLElement | null = null
let passwordExportEl: HTMLElement | null = null
let confirmDialogEl: HTMLElement | null = null
let confirmTitleEl: HTMLElement | null = null
let confirmMessageEl: HTMLElement | null = null
let confirmListEl: HTMLUListElement | null = null
let confirmCancelEl: HTMLElement | null = null
let confirmOkEl: HTMLButtonElement | null = null

export async function initApp() {
  const root = document.getElementById('csv-spreadsheet')
  const grid = document.getElementById('grid')
  emptyStateEl = document.getElementById('empty-state')
  dragOverlayEl = document.getElementById('drag-overlay')
  notifyEl = document.getElementById('notify')
  progressEl = document.getElementById('progress-bar')
  passwordDialogEl = document.getElementById('password-dialog')
  passwordTitleEl = document.getElementById('password-dialog-title')
  passwordInputEl = document.getElementById('password-input') as HTMLInputElement | null
  passwordConfirmEl = document.getElementById('password-confirm') as HTMLInputElement | null
  passwordErrorEl = document.getElementById('password-error')
  passwordCancelEl = document.getElementById('password-cancel')
  passwordExportEl = document.getElementById('password-export')
  confirmDialogEl = document.getElementById('confirm-dialog')
  confirmTitleEl = document.getElementById('confirm-dialog-title')
  confirmMessageEl = document.getElementById('confirm-dialog-message')
  confirmListEl = document.getElementById('confirm-dialog-list') as HTMLUListElement | null
  confirmCancelEl = document.getElementById('confirm-cancel')
  confirmOkEl = document.getElementById('confirm-ok') as HTMLButtonElement | null
  if (!root || !grid) return

  root.addEventListener('dragover', onDragOver)
  root.addEventListener('drop', onDrop)
  window.addEventListener('dragleave', onWindowDragLeave)
  window.addEventListener('dragend', clearDragOverlay)
  window.addEventListener('beforeunload', teardown)
  SHEETBRO_CHANNEL.addEventListener('message', onChannelMessage)
  window.addEventListener('storage', onStorageEvent)

  const instance = createUniver({
    locale: LocaleType.EN_US,
    locales: {
      [LocaleType.EN_US]: mergeLocales(
        UniverPresetSheetsCoreEnUS,
        UniverPresetSheetsFilterEnUS,
        { ribbon: { others: 'File', othersDesc: 'Export, safe-export, or clean up the workbook.' } },
      ),
    },
    presets: [
      UniverSheetsCorePreset({ container: grid }),
      UniverSheetsFilterPreset(),
    ],
  })
  univer = instance.univer
  univerAPI = instance.univerAPI

  try {
    storage = await initStorage()
  } catch (err) {
    console.error('Failed to initialize persistence', err)
    notify(err instanceof Error ? err.message : 'Persistence unavailable.', true)
  }

  if (storage) {
    try {
      const tabName = await initTabName(storage.db, storage.tabId)
      openTabRegistry.set(storage.tabId, tabName)
      writeTabRegistry({ tabId: storage.tabId, name: tabName, lastSeen: Date.now() })
      for (const entry of readAllTabRegistry()) {
        if (entry.tabId !== storage.tabId) openTabRegistry.set(entry.tabId, entry.name)
      }
      document.title = `${tabName} — sheet-bro`
    } catch (err) {
      console.error('Failed to initialize tab name', err)
    }
  }

  let snapshot: unknown = null
  let hadUnreadableRecord = false
  if (storage) {
    try {
      snapshot = await loadSnapshot(storage)
    } catch (err) {
      console.error('Failed to load saved workbook', err)
      notify('Saved data could not be decrypted — starting with an empty workbook.', true)
      hadUnreadableRecord = true
    }
  }

  let restored = false
  if (isPersistedSnapshot(snapshot)) {
    try {
      instance.univerAPI.createWorkbook(snapshot as Parameters<typeof instance.univerAPI.createWorkbook>[0])
      setHasData(true)
      restored = true
    } catch (err) {
      console.error('Saved workbook did not load into Univer', err)
      notify('Saved data looked corrupted — starting with an empty workbook.', true)
      hadUnreadableRecord = true
    }
  } else if (snapshot !== null) {
    console.warn('Saved workbook failed shape validation — starting empty.')
    notify('Saved data looked corrupted — starting with an empty workbook.', true)
    hadUnreadableRecord = true
  }
  if (!restored) {
    instance.univerAPI.createWorkbook({ name: 'Sheet' })
  }

  // If there's an existing but unreadable record, don't let the empty
  // fallback workbook's internal commands trigger auto-persist and
  // overwrite it. Dropping a new file re-enables the listener via
  // `loadIntoWorkbook` — that path represents an explicit user action
  // and is the correct moment to start persisting again.
  if (!hadUnreadableRecord) {
    commandListener = instance.univerAPI.addEvent(
      instance.univerAPI.Event.CommandExecuted,
      schedulePersist,
    )
  }

  registerFileMenu(instance.univerAPI)

  // Expose workbook inspection/mutation to Playwright only when the dev
  // server was started with VITE_E2E=1. Vite defines import.meta.env at
  // build time, so production bundles compile this branch out entirely.
  if (import.meta.env.VITE_E2E) {
    ;(window as unknown as { __sheetbro: unknown }).__sheetbro = {
      univerAPI: instance.univerAPI,
      setHasData,
      persistNow: persistWorkbook,
      readTabRegistry: () => readAllTabRegistry(),
      getTabId: () => storage?.tabId ?? null,
    }
  }

  requestAnimationFrame(() => root.classList.add('is-ready'))

  window.setTimeout(() => emptyStateEl?.classList.add('is-faded'), 30_000)

  // Prune cross-tab registry entries whose owning tab is gone
  // (crashed / force-killed — `beforeunload` never fired).
  void pruneRegistry()
  prunerTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void pruneRegistry()
  }, REGISTRY_PRUNE_INTERVAL_MS)
}

const REGISTRY_PRUNE_INTERVAL_MS = 30_000
let prunerTimer: number | null = null

async function pruneRegistry() {
  if (!storage) return
  const entries = readAllTabRegistry()
  await pruneStaleTabRegistry(storage.tabId, entries, (tabId) => {
    removeTabRegistry(tabId)
    openTabRegistry.delete(tabId)
  })
}

function setHasData(has: boolean) {
  if (emptyStateEl) emptyStateEl.hidden = has
}

function setDragActive(active: boolean) {
  if (dragOverlayEl) dragOverlayEl.hidden = !active
}

export function notify(message: string, sticky = false) {
  if (!notifyEl) return
  notifyEl.textContent = message
  notifyEl.hidden = false
  if (notifyTimer !== null) {
    window.clearTimeout(notifyTimer)
    notifyTimer = null
  }
  if (!sticky) {
    notifyTimer = window.setTimeout(() => {
      if (notifyEl) notifyEl.hidden = true
      notifyTimer = null
    }, NOTIFY_TIMEOUT_MS)
  }
}

function showProgress() {
  stopTimeFill()
  if (!progressEl) return
  // Hide briefly so the CSS transition resets to 0% without animating backward.
  progressEl.hidden = true
  progressEl.style.width = '0%'
  void progressEl.offsetWidth // force reflow before re-show
  progressEl.hidden = false
  progressValue = 0
}

function setProgress(pct: number) {
  progressValue = pct
  if (progressEl) progressEl.style.width = `${pct.toFixed(1)}%`
}

// Exponential-decay fill: advances toward `target`% at 8 % of the
// remaining gap every 100 ms — fast start, asymptotic slow-down near target.
function startTimeFill(target: number) {
  stopTimeFill()
  progressTimer = window.setInterval(() => {
    progressValue += (target - progressValue) * 0.08
    if (progressEl) progressEl.style.width = `${progressValue.toFixed(1)}%`
  }, 100)
}

function stopTimeFill() {
  if (progressTimer !== null) { window.clearInterval(progressTimer); progressTimer = null }
}

function completeProgress() {
  stopTimeFill()
  if (!progressEl) return
  progressEl.style.width = '100%'
  window.setTimeout(() => {
    if (!progressEl) return
    progressEl.hidden = true
    progressEl.style.width = '0%'
  }, 300)
}

// Reads a File into a string, firing onProgress(0–1) as bytes land.
function readFileAsText(file: File, onProgress: (fraction: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total) }
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file)
  })
}

// Reads a File into bytes, firing onProgress(0–1) as bytes land.
function readFileAsBytes(file: File, onProgress: (fraction: number) => void): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total) }
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file)
  })
}

function currentTabStem(): string | undefined {
  return storage ? (openTabRegistry.get(storage.tabId) ?? undefined) : undefined
}

function promptPassword(label: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!passwordDialogEl || !passwordTitleEl || !passwordInputEl || !passwordConfirmEl || !passwordErrorEl || !passwordCancelEl || !passwordExportEl) {
      resolve(null)
      return
    }

    passwordTitleEl.textContent = label
    passwordInputEl.value = ''
    passwordConfirmEl.value = ''
    passwordErrorEl.textContent = ''
    passwordDialogEl.hidden = false
    passwordInputEl.focus()

    function close() {
      if (passwordDialogEl) passwordDialogEl.hidden = true
      if (passwordInputEl)  passwordInputEl.value = ''
      if (passwordConfirmEl) passwordConfirmEl.value = ''
      passwordCancelEl!.removeEventListener('click', onCancel)
      passwordExportEl!.removeEventListener('click', onExport)
      document.removeEventListener('keydown', onKeydown)
    }

    function onCancel() { close(); resolve(null) }

    function onExport() {
      const pw = passwordInputEl!.value
      const confirm = passwordConfirmEl!.value
      if (pw.length < 16) {
        passwordErrorEl!.textContent = 'Password must be at least 16 characters — a short phrase works well.'
        return
      }
      if (pw !== confirm) {
        passwordErrorEl!.textContent = 'Passwords do not match.'
        return
      }
      close()
      resolve(pw)
    }

    function onKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape') { onCancel() }
      else if (e.key === 'Enter') { onExport() }
    }

    passwordCancelEl.addEventListener('click', onCancel)
    passwordExportEl.addEventListener('click', onExport)
    document.addEventListener('keydown', onKeydown)
  })
}

type ConfirmOptions = {
  title: string
  message: string
  details?: string[]
  confirmLabel?: string
  destructive?: boolean
}

function promptConfirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!confirmDialogEl || !confirmTitleEl || !confirmMessageEl || !confirmCancelEl || !confirmOkEl) {
      resolve(false)
      return
    }

    confirmTitleEl.textContent = opts.title
    confirmMessageEl.textContent = opts.message
    if (confirmListEl) {
      confirmListEl.replaceChildren()
      const items = opts.details ?? []
      if (items.length > 0) {
        for (const text of items) {
          const li = document.createElement('li')
          li.textContent = text
          confirmListEl.appendChild(li)
        }
        confirmListEl.hidden = false
      } else {
        confirmListEl.hidden = true
      }
    }
    confirmOkEl.textContent = opts.confirmLabel ?? 'OK'
    confirmOkEl.classList.toggle('is-danger', opts.destructive === true)
    confirmOkEl.classList.toggle('is-primary', opts.destructive !== true)
    confirmDialogEl.hidden = false
    confirmCancelEl.focus()

    function close() {
      if (confirmDialogEl) confirmDialogEl.hidden = true
      confirmCancelEl!.removeEventListener('click', onCancel)
      confirmOkEl!.removeEventListener('click', onOk)
      document.removeEventListener('keydown', onKeydown)
    }

    function onCancel() { close(); resolve(false) }
    function onOk() { close(); resolve(true) }

    function onKeydown(e: KeyboardEvent) {
      if (e.key === 'Escape') { onCancel() }
      else if (e.key === 'Enter') { onOk() }
    }

    confirmCancelEl.addEventListener('click', onCancel)
    confirmOkEl.addEventListener('click', onOk)
    document.addEventListener('keydown', onKeydown)
  })
}

function registerFileMenu(api: UniverAPI) {
  // The ribbon's SUBITEMS dispatcher executes commandService.executeCommand(item.id),
  // not item.commandId — so each dropdown action has to be registered as a command
  // under the same ID as its menu item. createMenu auto-generates commandIds when
  // given a function, but we need known IDs, so we (a) register commands manually,
  // (b) pass the id string as the createMenu action (which makes it use our id as
  // the commandId and skip its internal registration).
  const actions: Array<[string, () => void | Promise<void>]> = [
    ['sheet-bro.export.csv', () => runExport('CSV', async () => { await exportCsv(api, currentTabStem()); return null })],
    ['sheet-bro.export.xlsx', () => runExport('XLSX', async () => { await exportXlsx(api, currentTabStem()); return null })],
    ['sheet-bro.export.sql', () => runExport('SQL', () => exportSql(api, currentTabStem()))],
    ['sheet-bro.export.sqlite', () => runExport('SQLite', () => exportSqlite(api, currentTabStem()))],
    ['sheet-bro.safe.csv', () => runSafeExport('CSV', (pw) => safeExportCsv(api, pw, currentTabStem()))],
    ['sheet-bro.safe.xlsx', () => runSafeExport('Xlsx', (pw) => safeExportXlsx(api, pw, currentTabStem()))],
    ['sheet-bro.safe.sql', () => runSafeExport('SQL', (pw) => safeExportSql(api, pw, currentTabStem()))],
    ['sheet-bro.safe.sqlite', () => runSafeExport('SQLite', (pw) => safeExportSqlite(api, pw, currentTabStem()))],
    ['sheet-bro.cleanup.tab', () => void cleanupThisTab()],
    ['sheet-bro.cleanup.all', () => void cleanupAllTabs()],
  ]
  // Use a bootstrap FMenu just to reach the DI-provided command service.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bootstrap = api.createMenu({ id: '__sheet-bro.bootstrap', title: '', action: () => {} }) as any
  const cmdSvc = bootstrap._commandService
  for (const [id, handler] of actions) {
    if (!cmdSvc.hasCommand(id)) cmdSvc.registerCommand({ id, type: 1 /* CommandType.COMMAND */, handler })
  }

  const ecsv = api.createMenu({ id: 'sheet-bro.export.csv', title: 'CSV', order: 0, action: 'sheet-bro.export.csv' })
  const exlsx = api.createMenu({ id: 'sheet-bro.export.xlsx', title: 'Xlsx', order: 1, action: 'sheet-bro.export.xlsx' })
  const esql = api.createMenu({ id: 'sheet-bro.export.sql', title: 'SQL', order: 2, action: 'sheet-bro.export.sql' })
  const esqlite = api.createMenu({ id: 'sheet-bro.export.sqlite', title: 'SQLite', order: 3, action: 'sheet-bro.export.sqlite' })

  api.createSubmenu({ id: 'sheet-bro.file.export', title: 'Export', tooltip: 'Export', order: 0 })
    .addSubmenu(ecsv).addSubmenu(exlsx).addSubmenu(esql).addSubmenu(esqlite)
    .appendTo(['ribbon.others', 'ribbon.others.others'])

  const scsv = api.createMenu({ id: 'sheet-bro.safe.csv', title: 'CSV', order: 0, action: 'sheet-bro.safe.csv' })
  const sxlsx = api.createMenu({ id: 'sheet-bro.safe.xlsx', title: 'Xlsx', order: 1, action: 'sheet-bro.safe.xlsx' })
  const ssql = api.createMenu({ id: 'sheet-bro.safe.sql', title: 'SQL', order: 2, action: 'sheet-bro.safe.sql' })
  const ssqlite = api.createMenu({ id: 'sheet-bro.safe.sqlite', title: 'SQLite', order: 3, action: 'sheet-bro.safe.sqlite' })

  api.createSubmenu({ id: 'sheet-bro.file.safe-export', title: 'Safe Export', tooltip: 'Safe Export', order: 1 })
    .addSubmenu(scsv).addSubmenu(sxlsx).addSubmenu(ssql).addSubmenu(ssqlite)
    .appendTo(['ribbon.others', 'ribbon.others.others'])

  const ctab = api.createMenu({ id: 'sheet-bro.cleanup.tab', title: 'This Tab', order: 0, action: 'sheet-bro.cleanup.tab' })
  const call_ = api.createMenu({ id: 'sheet-bro.cleanup.all', title: 'All Tabs', order: 1, action: 'sheet-bro.cleanup.all' })

  api.createSubmenu({ id: 'sheet-bro.file.cleanup', title: 'Clean Up', tooltip: 'Clean Up', order: 2 })
    .addSubmenu(ctab).addSubmenu(call_)
    .appendTo(['ribbon.others', 'ribbon.others.others'])

  // The dropdown's onPress handler checks n.children (from the ribbon schema) FIRST.
  // FSubmenu.__getSchema() wraps children in a group-0 key; _buildMenuSchema then
  // produces n.children = [group-0-node] with no item property, so the dropdown
  // opens but renders nothing visible. Fix: merge the child schemas DIRECTLY into
  // sheet-bro.file.export in the nested tree. _buildMenuSchema then also produces
  // the direct item nodes as siblings of group-0, and onPress gets h = [group-0
  // (invisible), csvNode, xlsxNode, ...] — the items with item properties show up.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const menuSvc = (ecsv as any)._menuManagerService
  menuSvc.mergeMenu({
    'sheet-bro.file.export': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(ecsv as any).__getSchema(), ...(exlsx as any).__getSchema(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(esql as any).__getSchema(), ...(esqlite as any).__getSchema(),
    },
    'sheet-bro.file.safe-export': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(scsv as any).__getSchema(), ...(sxlsx as any).__getSchema(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(ssql as any).__getSchema(), ...(ssqlite as any).__getSchema(),
    },
    'sheet-bro.file.cleanup': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(ctab as any).__getSchema(), ...(call_ as any).__getSchema(),
    },
  })
}

type ExportResult = SqlExportResult | SqliteExportResult | null

async function runExport(label: string, run: () => Promise<ExportResult> | ExportResult) {
  try {
    const result = await run()
    if (result && result.tableCount === 0) {
      notify('Nothing to export — the workbook is empty.')
      return
    }
    if (result && result.generatedHeaderCount > 0) {
      const plural = result.generatedHeaderCount === 1 ? 'table' : 'tables'
      notify(
        `Exported ${result.tableCount} ${result.tableCount === 1 ? 'table' : 'tables'}` +
          ` — ${result.generatedHeaderCount} ${plural} with generated column names.`,
      )
    }
  } catch (err) {
    console.error(`Failed to export ${label}`, err)
    notify(toUserMessage(err, `Could not export to ${label}.`), true)
  }
}

async function runSafeExport(label: string, run: (password: string) => Promise<ExportResult> | ExportResult) {
  const password = await promptPassword(`Safe Export — ${label}`)
  if (password === null) return
  await runExport(label, () => run(password))
}

async function resetToEmpty(message: string) {
  if (persistTimer !== null) { window.clearTimeout(persistTimer); persistTimer = null }
  commandListener?.dispose()
  commandListener = null
  clearTabIdentity()
  if (storage) {
    closeStorage(storage)
    storage = null
  }
  try { storage = await initStorage() } catch (err) { console.error('Cleanup: failed to re-init storage', err) }
  if (univerAPI) {
    univerAPI.getActiveWorkbook()?.dispose?.()
    univerAPI.createWorkbook({ name: 'Sheet' })
  }
  document.title = 'sheet-bro'
  setHasData(false)
  notify(message)
}

async function cleanupThisTab() {
  const ok = await promptConfirm({
    title: 'Clean Up This Tab',
    message: "Permanently delete this tab's data and encryption key? This cannot be undone.",
    confirmLabel: 'Delete',
    destructive: true,
  })
  if (!ok) return
  if (storage) {
    try { await deleteRecord(storage) } catch (err) { console.error('Cleanup: failed to delete record', err) }
  }
  await resetToEmpty("This tab's data and encryption key have been cleared.")
}

async function cleanupAllTabs() {
  const current = storage
    ? { tabId: storage.tabId, name: openTabRegistry.get(storage.tabId) ?? '' }
    : null
  const entries = collectAffectedTabs(readAllTabRegistry(), current)
  const count = entries.length
  const displayNames = buildAffectedTabLabels(entries)
  const message = count > 0
    ? `Permanently delete data and encryption keys for ${count} tab${count === 1 ? '' : 's'}? This cannot be undone.`
    : 'Permanently delete data and encryption keys for ALL tabs? This cannot be undone.'
  const ok = await promptConfirm({
    title: 'Clean Up All Tabs',
    message,
    details: displayNames,
    confirmLabel: 'Delete All',
    destructive: true,
  })
  if (!ok) return
  if (storage) {
    try { await clearAllRecords(storage) } catch (err) { console.error('Cleanup: failed to clear all records', err) }
  }
  for (const entry of readAllTabRegistry()) removeTabRegistry(entry.tabId)
  SHEETBRO_CHANNEL.postMessage({ type: 'clear-all' })
  await resetToEmpty('All tab data and encryption keys have been cleared.')
}

function onChannelMessage(e: MessageEvent) {
  if ((e.data as { type: string } | null)?.type === 'clear-all') {
    void resetToEmpty('All tab data was cleared from another tab.')
  }
}

function onStorageEvent(e: StorageEvent) {
  if (!e.key?.startsWith(TAB_REGISTRY_PREFIX)) return
  const tabId = e.key.slice(TAB_REGISTRY_PREFIX.length)
  if (e.newValue === null) {
    openTabRegistry.delete(tabId)
    return
  }
  try {
    const entry = toTabRegistryEntry(JSON.parse(e.newValue), e.key)
    if (entry) openTabRegistry.set(tabId, entry.name)
  } catch {
    // ignore malformed entries
  }
}

function teardown() {
  SHEETBRO_CHANNEL.removeEventListener('message', onChannelMessage)
  window.removeEventListener('storage', onStorageEvent)
  window.removeEventListener('dragleave', onWindowDragLeave)
  window.removeEventListener('dragend', clearDragOverlay)
  if (storage) removeTabRegistry(storage.tabId)
  if (persistTimer !== null) {
    window.clearTimeout(persistTimer)
    persistTimer = null
  }
  commandListener?.dispose()
  commandListener = null
  if (progressTimer !== null) { window.clearInterval(progressTimer); progressTimer = null }
  if (prunerTimer !== null) { window.clearInterval(prunerTimer); prunerTimer = null }
  if (storage) {
    closeStorage(storage)
    storage = null
  }
  univer?.dispose()
  univer = null
  univerAPI = null
}

function persistWorkbook() {
  persistTimer = null
  if (!univerAPI || !storage) return
  const wb = univerAPI.getActiveWorkbook()
  if (!wb) return
  const snapshot = wb.save()
  saveSnapshot(storage, snapshot).catch((err) => {
    if (err instanceof DOMException && err.name === 'QuotaExceededError') {
      notify('Workbook too large to save — your changes will not persist.', true)
    } else {
      console.error('Failed to persist workbook', err)
    }
  })
  // Keep localStorage lastSeen fresh so the cross-tab registry stays current.
  const name = openTabRegistry.get(storage.tabId) ?? ''
  writeTabRegistry({ tabId: storage.tabId, name, lastSeen: Date.now() })
}

function schedulePersist() {
  if (persistTimer !== null) window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(persistWorkbook, PERSIST_DEBOUNCE_MS)
}

function onDragOver(e: DragEvent) {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  setDragActive(true)
  if (dragIdleTimer !== null) window.clearTimeout(dragIdleTimer)
  dragIdleTimer = window.setTimeout(clearDragOverlay, 700)
}

function clearDragOverlay() {
  if (dragIdleTimer !== null) {
    window.clearTimeout(dragIdleTimer)
    dragIdleTimer = null
  }
  setDragActive(false)
}

function onWindowDragLeave(e: DragEvent) {
  // Fire only when the drag actually leaves the viewport, not when it
  // crosses between child elements. Chromium/WebKit null relatedTarget
  // on window exit; Firefox doesn't always, so also check coordinates.
  if (
    e.relatedTarget === null ||
    e.clientX <= 0 ||
    e.clientY <= 0 ||
    e.clientX >= window.innerWidth ||
    e.clientY >= window.innerHeight
  ) {
    clearDragOverlay()
  }
}

function onDrop(e: DragEvent) {
  e.preventDefault()
  clearDragOverlay()
  const files = e.dataTransfer?.files
  if (!files || files.length === 0) return
  if (files.length > 1) {
    notify('Drop one file at a time — only the first will be loaded.')
  }
  const file = files[0]
  if (file.size > MAX_FILE_BYTES) {
    notify(
      `File too large (${(file.size / 1e6).toFixed(1)} MB; limit is ${MAX_FILE_BYTES / 1e6} MB).`,
      true,
    )
    return
  }
  runImport(file)
}

export async function runImport(file: File) {
  showProgress()

  let kind: Awaited<ReturnType<typeof detectFileKind>>
  try {
    kind = await detectFileKind(file)
  } catch (err) {
    console.error('Failed to sniff file type', err)
    notify(toUserMessage(err, 'Could not read file.'), true)
    completeProgress()
    return
  }

  const label = labelForKind(kind)

  // One shared timeout races all async phases (file read + parse).
  let timeoutId: number | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(
      () => reject(new UserFacingError('Import timed out — the file may be too complex or corrupted.')),
      IMPORT_TIMEOUT_MS,
    )
  })

  // sql.js runs in a Web Worker so the timeout race can `terminate()` a
  // runaway parse. XLSX stays on the main thread because
  // `read-excel-file/browser` uses DOMParser, which isn't available in
  // workers. CSV is fast enough that the postMessage copy isn't worth it.
  const activeWorker: { current: Worker | null } = { current: null }
  const runInWorker = (job: WorkerJob, transfer: Transferable[] = []): Promise<LoadedSheet[]> =>
    new Promise<LoadedSheet[]>((resolve, reject) => {
      const w = new ParserWorker()
      activeWorker.current = w
      w.addEventListener('message', (e: MessageEvent<WorkerResult>) => {
        if (e.data.ok) resolve(e.data.sheets)
        else reject(e.data.userFacing ? new UserFacingError(e.data.message) : new Error(e.data.message))
      })
      w.addEventListener('error', (e) => reject(new Error(e.message || 'worker error')))
      w.postMessage(job, transfer)
    })

  try {
    let sheets: LoadedSheet[]

    if (kind === 'xlsx') {
      // No accessible byte-read phase for XLSX — time-fill covers the whole parse.
      startTimeFill(80)
      sheets = await Promise.race([importXlsx(file), timeoutPromise])
    } else if (kind === 'csv') {
      // Phase 1 (0→30 %): real byte-read progress.
      const text = await Promise.race([
        readFileAsText(file, p => setProgress(p * 30)),
        timeoutPromise,
      ])
      setProgress(30)
      // Phase 2 (30→80 %): time-fill during PapaParse.
      startTimeFill(80)
      sheets = await Promise.race([parseCsvText(text), timeoutPromise])
    } else if (kind === 'sql') {
      // Phase 1 (0→30 %): real byte-read progress.
      const text = await Promise.race([
        readFileAsText(file, p => setProgress(p * 30)),
        timeoutPromise,
      ])
      setProgress(30)
      // Phase 2 (30→80 %): time-fill during dialect normalisation + sql.js exec.
      startTimeFill(80)
      sheets = await Promise.race([runInWorker({ job: 'sql-dump', text }), timeoutPromise])
    } else {
      // sqlite — Phase 1 (0→30 %): real byte-read progress.
      const bytes = await Promise.race([
        readFileAsBytes(file, p => setProgress(p * 30)),
        timeoutPromise,
      ])
      setProgress(30)
      // Phase 2 (30→80 %): time-fill during sql.js DB open + table reads.
      startTimeFill(80)
      // Transfer the buffer so a multi-MB SQLite file isn't structured-cloned.
      sheets = await Promise.race([
        runInWorker({ job: 'sqlite', bytes }, [bytes.buffer]),
        timeoutPromise,
      ])
    }

    // Phase 3: stop fill, snap to 85 %, build + render workbook (synchronous).
    stopTimeFill()
    setProgress(85)
    await loadIntoWorkbook(sheets, file)
  } catch (err) {
    console.error(`Failed to import ${label}`, err)
    notify(toUserMessage(err, `Could not read ${label}.`), true)
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId)
    // Terminate the parser worker unconditionally — on success it's idle,
    // on timeout/error it may still be spinning on a hostile file.
    activeWorker.current?.terminate()
    activeWorker.current = null
    completeProgress()
  }
}

async function loadIntoWorkbook(sheets: LoadedSheet[], file: File) {
  if (!univerAPI || !univer) return
  if (sheets.length === 0) return

  const shape = buildWorkbookShape(sheets)

  const existing = univerAPI.getActiveWorkbook()
  existing?.dispose?.()

  univerAPI.createWorkbook(shape)

  // Re-arm auto-persist if it was suppressed during initApp because an
  // unreadable record was still in IndexedDB. Dropping a new file is an
  // explicit user intent to overwrite.
  if (!commandListener && univerAPI) {
    commandListener = univerAPI.addEvent(
      univerAPI.Event.CommandExecuted,
      schedulePersist,
    )
  }

  if (storage) {
    const name = fileBasedTabName(file.name)
    try {
      await setTabName(storage.db, storage.tabId, name)
    } catch (err) {
      console.error('Failed to set tab name', err)
    }
    openTabRegistry.set(storage.tabId, name)
    writeTabRegistry({ tabId: storage.tabId, name, lastSeen: Date.now() })
    document.title = `${name} — sheet-bro`
  }

  setHasData(true)
  persistWorkbook()
}

export function getOpenTabs(): Array<{ tabId: string; name: string; isCurrent: boolean }> {
  return Array.from(openTabRegistry.entries()).map(([tabId, name]) => ({
    tabId,
    name,
    isCurrent: tabId === storage?.tabId,
  }))
}

