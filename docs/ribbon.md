# Ribbon menu

The File ribbon tab in this app is built on top of Univer's menu
system through two workarounds. Both are brittle — they reach into
Univer internals — but there is no public alternative.

## The `mergeMenu` trap — only seeded keys accept children

`univerAPI.createMenu({...}).appendTo(path)` ultimately calls
`IMenuManagerService.mergeMenu`, which **only updates keys that
already exist in the seeded menu skeleton**. You cannot create a
brand-new ribbon tab via `appendTo(['ribbon.export',
'ribbon.export.main'])` — the `ribbon.export` key isn't in the
skeleton, so the merge is a silent no-op.

The File tab exists by *repurposing* the seeded-but-unused
`ribbon.others` slot. The label is overridden via `mergeLocales`
(`src/app.ts:110`):

```ts
mergeLocales(..., { ribbon: { others: 'File',
                              othersDesc: 'Export, safe-export, or clean up the workbook.' } })
```

The pre-seeded ribbon tabs (`ribbon.start`, `ribbon.insert`,
`ribbon.formulas`, `ribbon.data`, `ribbon.view`, `ribbon.others`)
are the only valid top-level slots. Empty tabs are filtered out at
render time, which is why "Insert" and "View" never appear.

If you ever need a *truly* new tab, you'd have to access
`IMenuManagerService` directly via the Univer injector and call
`appendRootMenu`, which the public facade doesn't expose.

## The submenu/children trap — `addSubmenu` renders empty

`createSubmenu(...).addSubmenu(leaf).appendTo(['ribbon.others',
'ribbon.others.others'])` compiles fine but the dropdown opens empty.
`FSubmenu.__getSchema()` wraps children in a group-0 key. The ribbon
schema builder then produces `n.children = [group-0-node]` with no
`item` property, and the dropdown's `onPress` handler checks
`n.children` **before** `n.item`, so it bails on the group wrapper
and renders nothing.

Workaround (`src/app.ts:451-469`): after `appendTo`, reach into
`_menuManagerService` and `mergeMenu` each leaf's `__getSchema()`
directly into the submenu key. `_buildMenuSchema` then produces the
direct item nodes as siblings of `group-0`, and `onPress` gets
`h = [group-0 (invisible), csvNode, xlsxNode, ...]` — the items with
`item` properties show up.

```ts
const menuSvc = (ecsv as any)._menuManagerService
menuSvc.mergeMenu({
  'sheet-bro.file.export': {
    ...(ecsv as any).__getSchema(), ...(exlsx as any).__getSchema(),
    ...(esql as any).__getSchema(), ...(esqlite as any).__getSchema(),
  },
  'sheet-bro.file.safe-export': { ... },
  'sheet-bro.file.cleanup': { ... },
})
```

## Commands must share leaf IDs — the bootstrap-menu escape hatch

The ribbon's SUBITEMS dispatcher executes
`commandService.executeCommand(item.id)`, **not** `item.commandId`.
So every leaf has to be registered as a command under the same ID as
its menu item. `createMenu({...action: fn})` auto-generates a
command ID you can't control; passing `action: '<same id>'` (a
string) makes Univer skip its internal registration and use your ID
as the command ID.

Reaching the command service from the public facade requires a
throwaway `__sheet-bro.bootstrap` menu whose `_commandService` field
is exposed on the returned `FMenu` (`src/app.ts:412-416`):

```ts
const bootstrap = api.createMenu({ id: '__sheet-bro.bootstrap', title: '', action: () => {} }) as any
const cmdSvc = bootstrap._commandService
for (const [id, handler] of actions) {
  if (!cmdSvc.hasCommand(id)) cmdSvc.registerCommand({ id, type: 1 /* CommandType.COMMAND */, handler })
}
```

## Menu inventory

Current File ribbon content (`src/app.ts:391-470`):

- **Export** → `CSV`, `Xlsx`, `SQL`, `SQLite`
- **Safe Export** → `CSV`, `Xlsx`, `SQL`, `SQLite` (AES-encrypted
  ZIP, prompts for a password; see `docs/exporters.md`)
- **Clean Up** → `This Tab`, `All Tabs` (both route through
  `promptConfirm` — the in-app confirm modal)

Leaf IDs follow `sheet-bro.<submenu>.<format>` and are also used as
command IDs.

## Z-index tiers

Univer paints an opaque ribbon background in its own stacking
context. Anything inside `.csv-spreadsheet` that needs to overlay
the ribbon must use a z-index in the same league:

- `.app-logo` → `z-index: 9999` — topmost, always wins.
- `.empty-state` → `z-index: 9998` — above the Univer grid but
  below the logo. Use this tier for any future persistent overlay.
- `.drag-overlay` → `z-index: 3` — only appears during a drag and
  gets away with a low value because Univer's grid hasn't been
  observed to cover it in practice. Bump to `9997` if that changes.

Anything below `~9998` will be covered by parts of the Univer UI.
