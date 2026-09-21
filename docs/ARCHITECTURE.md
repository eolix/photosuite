# Architecture

How the source tree is organised, and the one rule that keeps it navigable:
**imports only ever point downward.** A contributor should be able to answer
"where does the code that does X live?" from the tree alone.

`src/vendor/` (third-party libraries) and `src/wasm/` (compiled modules) sit
outside this scheme — see [Vendored code](#vendored-code).

---

## 1. Layers

Every module belongs to exactly one layer, and may import only from layers below
it:

```
  app          entry point and application shell object
  ui           panels, dialogs, widgets, menus, the window shell
  features     layer features: adjustments, filters, styles, text, brushes, scripting
  document     the runtime document model, editing tools, and all file read/write
  engine       the raster / compositing engine
  core         framework primitives: math, binary, i18n, events, input
```

`engine/` imports only `core/`. The document model sits on `core` + `engine`,
features on the document model, and so on upward.

`core/` is the bottom of the graph and its modules import only other `core/`
files — with one deliberate exception. `core/startup-wiring.js` is the startup
wiring module: it reaches up into `app`, `engine`, `document` and `features` precisely
so that nothing else has to. It is the single place where the layers are joined,
which is what lets every other module import strictly downward.

The graph is acyclic: `node scripts/find-import-cycles.mjs` reports **zero
import cycles** outside `vendor/`, and `npm run verify` fails the build if that
regresses. Two conventions keep it that way:

- **No barrel files.** There is no `index.js` anywhere in `src/`. Every import
  names the file that defines the symbol, so the dependency graph is what the
  imports say it is.
- **No registries.** Nothing crosses a layer boundary by any route other than
  an import. There is no namespace object a module attaches itself to, nothing
  is published on `globalThis`, and every symbol is reached from the file that
  defines it.

Each major folder carries its own `README.md` charter: [`core/`](../src/core/README.md),
[`engine/`](../src/engine/README.md), [`document/`](../src/document/README.md),
[`document/formats/`](../src/document/formats/README.md), [`ui/`](../src/ui/README.md).

---

## 2. The tree

```
src/
  main.js                     entry point: wiring, then boot
  index.html                  document shell; loads vendor scripts and main.js

  core/                       framework primitives, zero editing domain knowledge
    math/                     Point, Rect, Matrix2D
    binary/                   BinaryUtils, BinarySchemaDecoder
    i18n/                     locale lookup and translation tables
    startup-wiring.js         layer wiring and script-host bindings
    app-settings.js  event-bus.js  event-emitter.js  keyboard-handler.js
    system-clipboard.js  render-buffer.js  recent-files.js  file-names.js

  engine/                     the pixel engine; operates on bitmaps only
    compositing/              blend modes, colour math, convolution, warp,
                              dithering, quantizers, geometry, path rendering,
                              selection ops, content-aware fill, camera raw
    layer-system.js           LayerSystem: GL context, shader programs,
                              render targets and texture bookkeeping

  document/
    render/                   the walk that turns a layer tree into pixels
    layer-thumbnails.js       layer/channel/path panel thumbnail painters
    model/                    the runtime document object model
      document.js             Document, HistoryEntry
      layer.js  layer-group.js  placed-layer.js  blend-modes.js
      canvas-viewport.js  axis-drag-anchor.js
      guide-snapping.js  layer-translate.js  layer-masks.js
      tool-base.js            ToolBase, ToolId, EventChannel
    tools/                    interactive editing tools
      paint  selection  lasso  move  crop  retouch  shape  text  pen-path  view
    transform/                transform box, free transform, puppet warp, slices
    formats/                  everything that reads or writes a file
      <ext>-format.js         one module per foreign format: ai, cdr, dxf, fig,
                              sketch, xd, svg, af, xcf, fpng
      registry/               format detection, encode/decode dispatch, open/save
      codecs/                 encode/decode against the registry: jpeg, webp,
                              avif, camera-raw, vector, and layered-codec.js
                              (PSD, PXD, Sketch, XD, Figma, XCF, FPNG, PDN)
      psd/                    PSD binary parsers and descriptor codecs
      metadata/               ICC, XMP, plist, RIFF, IFF, SQLite containers

  features/                   layer features, built on the document model
    adjustments/  layer-styles/  text/  brush/  gradient/  pattern/  shape/
    swatch/  tool-preset/  scripting/  css-export/  trackers/  plugins/
    filters/                  smart filters, the filter registry, and
      gallery/                the filter gallery with its pixel engine
        workers/              off-thread band rendering

  ui/
    shell/                    AppController, document view, window, file loading
    panels/                   the right-sidebar panels (layers, history, …)
    dialogs/                  modal and modeless dialogs
    widgets/                  reusable controls
      controls/               colour, font, brush, effect pickers
    menu/                     menu bar data and the native menu bridge
    layout/                   sidebar, tabs, header bars
    filter-panels/            per-filter parameter UI
    tool-options/             the tool options bar
    config/                   popup types, themes, presets
    ui.js                     UI bootstrap

  fonts/                      font registry, system font catalog, Typr worker
  assets/                     icon registry and icon files
  resources/  style/               bundled resources and stylesheets
  vendor/  wasm/              third-party code (see below)
```

---

## 3. Naming conventions

- **kebab-case** file names, one cohesive concept per file. A file of 800–1200
  lines is fine when it is genuinely one concept; one function per file is not.
- **The folder already says it.** Inside `features/layer-styles/` the file is
  `style-renderer.js`, not `layer-layer-style-render-util.js`.
- **Specific over generic.** The layered-document codec is
  `formats/codecs/layered-codec.js`, not `document.js`.
- **One `<ext>-format.js` per foreign format**, named for the extension and
  owning both read and write where the format supports both. A header comment
  names the full format where the extension is terse.
- **Wiring modules** that exist for their import side effects are allowed, but
  are named for the job they do (`features/trackers/register-trackers.js`) and
  re-export nothing.
- **Tool modules** export the tools they define and chain those tools'
  prototypes onto the base they extend, at module scope.
- **PSD wire keys are not identifiers.** Four-character descriptor keys and tags
  (`TySh`, `vmsk`, `SoCo`, `Strt`, `H`) are the binary format's own names and are
  never renamed. See [`.claude/rules/psd-descriptor-keys.md`](../.claude/rules/psd-descriptor-keys.md);
  `node scripts/extract-psd-descriptor-catalog.mjs` lists every key the tree uses.

---

## 4. Startup wiring

`main.js` runs a fixed sequence before the first paint:

1. **`core/startup-wiring.js`** imports every tool module for the prototype
   chaining they do at module scope, registers the document-event trackers
   (`features/trackers/register-trackers.js`), and installs the script-host
   bindings described in [Scripting](#5-scripting).
2. **`initLayerSystemGl()`** gives the layer system its canvas and GL context.
   Until it runs, `LayerSystem` reports WebGL off and the CPU paths serve.
3. **`FileFormatRegistry.installLoaders(…)`** receives a bag of format loaders
   assembled in `main.js`.
4. **`ui/ui.js`** imports the filter and adjustment panels for their
   registration side effects, builds the menu bar data, and boots
   `AppController` on window load.
5. **System fonts** are discovered on a deferred timer so the first paint is not
   blocked on filesystem access.

Icons need no startup step: panels import `getIconUrl` from
`assets/icon-registry.js` and the module graph orders it.

### How tools reach their base

A tool module exports its tools and, at module scope, chains each prototype onto
the base it extends with `Object.create(Base.prototype)`. Naming a base means
importing it, and ESM evaluates an imported module first, so the base is always
finished before anything extends it — there is no registration order to
maintain and no pipeline to run.

`ToolId` and `EventChannel` in `document/model/tool-base.js` are the id tables
tools are selected and routed by.

Format loaders are the one thing still handed over rather than imported:
`main.js` gives them to `FileFormatRegistry`, so a format loader never has to
import the registry and close a cycle.

Everything else imports the module that defines what it needs.

---

## 5. Scripting

The app runs user-supplied scripts: PSD action strings, script payloads carried
by a document, and launch scripts. They are not handed to the JavaScript engine.
`features/scripting/script-engine.js` parses the source with acorn and walks the
AST itself, which means every free identifier in a script is resolved by
`features/scripting/script-host-context.js` rather than by scope lookup.

A script can name three things:

- the language builtins in `SCRIPT_BUILTIN_BINDINGS` (`Math`, `JSON`, `Date`,
  the typed arrays, the URI helpers, `console`),
- the bindings startup installed — the Photoshop scripting API surface, the
  document model types, the imaging and text namespaces, and `alert`, which is
  the flying-banner toast rather than a blocking dialog,
- whatever it declares itself.

Everything else resolves to `null`. `window` and `globalThis` inside a script
are its own globals object (`env.__scriptGlobals`), not the page. The DOM, the
Tauri bridge, the network and the module graph have no name a script can reach
them by, and adding a binding is an explicit call in `core/startup-wiring.js`.

---

## 6. Vendored code

`src/vendor/` holds third-party libraries, most as git submodules pinned to an
upstream commit, plus generated single-file builds under `vendor/js/` and
compiled modules under `vendor/wasm/`. `src/wasm/` holds WebAssembly built from
this repository.

Vendored code keeps its upstream style, naming, and licence headers, and is
excluded from linting and from the conventions above. See
[`src/vendor/README.md`](../src/vendor/README.md) for the per-library inventory,
licences, and build commands.

---

## 7. Checks

| Command | What it enforces |
|---------|------------------|
| `npm run lint` | ESLint over `src/`: undefined names, a dangling `export { X }`, and the recommended rule set |
| `npm run verify:imports` | every relative import resolves, and names a concrete file rather than a directory |
| `npm run verify:bindings` | every `import { X }` names something the target exports, nothing assigns to an import, no free function is called as a method |
| `npm run verify:cycles` | no import cycle outside `vendor/` |
| `npm run verify:statics` | every `X.y()` call has something that assigns `X.y` |
| `npm run verify:shadows` | no local hides a module-scope function it then calls |
| `npm run verify:prototypes` | no prototype is built from a constructed instance |
| `npm run verify:bootstrap` | `main.js` / `index.html` load order |
| `npm test` | the behavioural suite in [`tests/`](../tests/README.md) |

`npm run lint` and `npm run verify` together run the whole set. `npm run install:git-hooks` installs a
pre-commit hook that runs it together with the tests.
