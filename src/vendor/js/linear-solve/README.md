# linear-solve (generated)

Browser script exposing the global `linear` (Gauss-Jordan matrix solve / invert),
**generated** from the [`lovasoa/linear-solve`](https://github.com/lovasoa/linear-solve)
submodule at `src/vendor/linear-solve` (v1.2.1, MIT). Run `./build.sh` — don't
edit `linear-solve.js` by hand.

| File | Source |
|------|--------|
| `linear-solve.js` | `vendor/linear-solve/gauss-jordan.js` **verbatim**, wrapped in an IIFE |
| `LICENSE` | MIT, © 2016 Ophir Lojkine (authored here — upstream ships none) |

## Why a build step

`gauss-jordan.js` is a CommonJS module: it attaches to an ambient `exports`
(never declared locally) and ends with `module.exports = linear`. Loaded as a bare
browser `<script>` that throws (`exports`/`module` undeclared). `build.sh` wraps the
upstream file **unmodified** in an IIFE that supplies a *local* `module`/`exports`
and returns it as the global `linear`:

```js
var linear = (function () {
  var module = { exports: {} };
  var exports = module.exports;
  /* …gauss-jordan.js verbatim… */
  return module.exports;
})();
```

The `module`/`exports` stay **local** on purpose — leaking a global `module` would
flip later UMD libs (uzip, paper, sha1) into CommonJS mode and stop them defining
their browser globals. `build.sh` self-tests the output (`invert`/`solve`) and
aborts if upstream changes break it.

## API used by the app

Only `linear.invert(matrix)` — single caller `src/engine/compositing/path-renderer.js`.
(`linear.solve(A, b)` is also exposed but unused.)

## Regenerating

```sh
git submodule update --remote src/vendor/linear-solve   # optional: pull newer upstream
src/vendor/js/linear-solve/build.sh
```
