# acorn (generated)

Browser bundle of the [acorn](https://github.com/acornjs/acorn) JavaScript parser,
**generated** from the submodule at `src/vendor/acorn` (pinned **3.1.0**, MIT).
Exposes the global `acorn`; the app uses only `acorn.parse(code)`
(`src/layers/layer-script-engine.js`). Run `./build.sh` — don't edit `acorn.js` by hand.

| File | Source |
|------|--------|
| `acorn.js` | `vendor/acorn/src/` bundled with esbuild (IIFE, global `acorn`) |
| `LICENSE` | copied from the submodule (MIT) |

## Why a build step (and why pinned to 3.1.0)

Acorn 3.x keeps its source as ES modules and builds `dist/acorn.js` with a 2015-era
Babel-5/browserify toolchain that no longer runs on modern Node. `build.sh` bundles the
same source with esbuild instead; the output is AST-identical to acorn's own 3.1.0 dist.

The version is pinned to 3.1.0 deliberately: the app calls `acorn.parse(code)` with **no
options**, which acorn 8.x rejects (it requires `ecmaVersion`), and newer versions emit a
different AST shape. Bumping the version would need the call sites and AST consumers updated.

## Regenerating

```sh
git submodule update --init src/vendor/acorn
src/vendor/js/acorn/build.sh        # needs Node + npx (fetches esbuild)
```
