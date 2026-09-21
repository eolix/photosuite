# Tests

The suite is the behavioural spec for `src/`. It exists so the tree can be
changed without silently altering what the app does: if an edit alters a
parsed byte, a dispatched action, a computed layout or a registered tool, a test
here fails. Treat the current behaviour as the baseline these tests protect.

Run it with Node's built-in runner — there is no test framework to install:

```bash
npm test                                   # the whole suite
node --test tests/core/math/point.test.js  # one file
node --test tests/engine/                  # one area
```

Read the tally as `tests` / `pass` / `fail` / **`cancelled`**. A `before()` hook
that throws cancels every test in its file while `fail` stays at zero, so a run
can lose a whole file and still look green if you only read `fail`.

## Layout

Each test mirrors the path of the module it covers, with a `.test.js` suffix:

```
src/core/math/point.js                  ->  tests/core/math/point.test.js
src/document/formats/psd/psd-parser.js  ->  tests/document/formats/psd/psd-parser.test.js
```

`tests/helpers/` holds shared fixtures rather than tests:

| Helper | Purpose |
|--------|---------|
| `stub-browser-globals.js` | Minimal `document` / `window` so UI modules import under Node. Returns a restore function. |
| `minimal-app-controller.js` | An `AppController` stand-in plus Tauri store and window mocks. |

Rust tests live with the Rust, under `src-tauri/` — `cargo test` does not read
this directory.

## What a test should assert

Assert what the module *does*: values it computes, bytes it writes, events it
dispatches, state it mutates. A test that only checks a symbol is exported or
that a function takes N parameters passes just as happily after the behaviour
behind it is gutted, so it buys nothing an ordinary edit would not already break
loudly.

Drive the real implementation. A test that stubs the helper it is exercising —
a byte-wise `copyBuffer`, a no-op simplifier, a forced answer from a predicate —
measures the stub, and several here did exactly that until the stubs drifted
from the engine and nobody noticed.

- **Pure modules** (math, colour, binary, parsers) — assert real values.
  Golden byte sequences and expected numbers belong inline as literals so the
  test stays readable and self-contained.
- **Codecs and file formats** — round-trip where the format allows it (encode →
  decode → compare), and pin the header bytes that identify the format.
- **DOM- and Tauri-bound modules** — install the browser stubs, then drive the
  behaviour: dispatch an event and assert the payload, resize and assert the
  computed geometry, feed a device list and assert what gets offered.
  Constructors that boot the whole widget stack (canvas thumbnails, the font
  engine) are better driven through `Object.create(Type.prototype)` with the
  state the method under test actually reads.

Keep stub-sensitive expectations out: assert what a real browser would do, not
what the stub happens to return.

## Areas worth knowing about

| Path | What it guards |
|------|----------------|
| `bootstrap/` | `main.js` / `index.html` / icon-registry load order. Pairs with `npm run verify:bootstrap`. |
| `document/tools/tool-prototype-integrity.test.js` | A tool left on `ToolBase`'s empty stub because its own method was overwritten. Import-time checks cannot see this: the tool imports and constructs fine, it just does nothing. |
| `document/tool-prototype-chains.test.js` | Every tool family actually inherits from the base it extends. A tool whose chaining is dropped also imports and constructs fine. |
| `core/event-emitter.test.js` | Two instances of a shared base keep their own state, and nothing is left on the prototype for them to share. |
| `core/app-settings.test.js`, `features/filters/gallery/filter-gallery-thumbnail-store.test.js` | Persist↔apply and encode↔decode round trips: what one module writes, another reads back unchanged. |

## Tools that run alongside

```bash
npm run lint     # undefined names, dangling exports, recommended rules
npm run verify   # import resolution, import bindings, import cycles, statics,
                 # shadowed bindings, prototype chains, bootstrap
```

Several of those gates exist because a bug got past the suite first: a call to a
static that had moved, a parameter shadowing the import it was about to call, a
prototype built from a constructed instance. Each one was checked against the
bug it was built for — it has to fail when that bug is put back.

`npm run install:git-hooks` installs a pre-commit hook running `npm run verify`
and `npm test`.
