# core — framework primitives

Environment and framework primitives with **zero image-editing domain
knowledge**. This is the bottom of the dependency graph: `core/` modules import
only other `core/` files, and everything else may import them.

The exception is `startup-wiring.js`. It imports upward into `engine`,
`document` and `features` to bind the names user scripts resolve against, to
pull in the tool modules for the prototype chaining they do at module scope, and
to register the document-event trackers — it is the one place the layers are
joined, so that no other module has to reach upward.

| Area | Contents |
|------|----------|
| `math/` | `Point`, `Rect`, `Matrix2D` |
| `binary/` | `BinaryUtils`, `BinarySchemaDecoder` |
| `i18n/` | locale lookup + translation tables |
| events | `event-bus.js`, `event-emitter.js` |
| input | `keyboard-handler.js` |
| host/runtime | `startup-wiring.js` (layer wiring and script-host bindings), `app-settings.js`, `system-clipboard.js`, `render-buffer.js`, `editor-persisted-params.js` |

**Rule:** if a module needs to know about layers, documents, file formats, or
the UI, it does not belong in `core/`.

See [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) for the full layering.
