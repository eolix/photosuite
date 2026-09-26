# uiGradients data (generated)

`extra_gradients.grd` — the Gradient tool's "bundled library" gradient file at
`src/resources/libraries/extra_gradients.grd` — is **generated** from
`gradients.json` in this folder. Do not edit `extra_gradients.grd` by hand —
run `./build.sh`.

| File | Source |
|------|--------|
| `gradients.json` | copied verbatim from [ghosh/uiGradients](https://github.com/ghosh/uiGradients), pin `afb018418e92c3fa4048daa88eb6525a78f5486e` (master, fetched 2026-09-26) — 382 named gradient definitions (`{ name, colors: ["#hex", ...] }`) |
| `LICENSE` | copied from the same repo (MIT) |

## Licence

MIT — community-contributed gradient definitions under the same repo licence
as the code; see `LICENSE`.

## Regenerating

```sh
# optional: pull a newer gradients.json snapshot and bump the pin above first
src/vendor/js/uigradients/build.sh
```

The generated file is committed so a fresh clone runs without rebuilding.
