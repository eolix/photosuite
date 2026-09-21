# UI module layout

Entry point: `ui.js` (bootstrap only). Do **not** import `ui.js` from feature
code — import the specific module you need.

## Folders

| Folder | Role |
|--------|------|
| `config/` | Theme tokens, popup type ids (no DOM) |
| `shell/` | App lifecycle: `app-controller` and its split concerns (launch, ui-dispatch, keyboard, tools, tool-registry, clipboard), the window, document view, overlays, cursor overlay, splash, file loading |
| `layout/` | Persistent chrome: sidebars, tabs, link/confirm bars |
| `tool-options/` | Active tool UI: option bar, tool options, context menus (`InputHandler`) |
| `menu/` | Menu bar data, native/Tauri bridge, dispatch — see [`menu/README.md`](menu/README.md) |
| `panels/` | Dockable workspace panels, and the rows and gestures a panel owns |
| `dialogs/` | Modal and modeless dialogs |
| `filter-panels/` | Filter / adjustment / gallery parameter UI |
| `widgets/` | Reusable controls; `widgets/controls/` holds the pickers (colour, font, brush, effect) |

The folder is the answer to "where does this go": a panel goes in `panels/`, the
row it draws goes there too, and a control two panels share goes in `widgets/`.
Listing every file here only produces a list that is wrong a week later — use
`ls`, and keep the file names saying what they are.

## Naming

- **Files & directories:** `kebab-case` (`channels-panel.js`, `filter-stack-panel.js`)
- **Exports:** `PascalCase` classes (`ChannelsPanel`, `InputHandler`)
- **No barrels:** there are no `index.js` re-export files; import the concrete
  module that defines the symbol.

## How a filter panel is found

`FilterParameterPanel` doubles as the table: a filter's panel is assigned as
`FilterParameterPanel[filterId]`, and `filter-parameter-panel.js` looks the id
up when the dialog opens. A new filter panel is a new assignment in the module
that defines it — `builtin-filter-panels.js`, `adjustment-panels.js`, or its own
file for the large ones (`camera-raw-panel.js`, `lens-correction-panel.js`,
`liquify-panel.js`).

## Import rules

1. Feature modules import the concrete widget file they need, never `ui.js`.
2. Do not import `shell/app-controller.js` from panels, dialogs, or widgets.
3. Prefer `ui/config/popup-types.js` over deep cross-folder reaches.
4. Engine and document code must not import the UI shell.

## Checks

```bash
node scripts/check-ui-imports.mjs
```
