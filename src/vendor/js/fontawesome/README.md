# Font Awesome shapes (generated)

`extra_shapes.csh` — the Shape tool's "bundled library" custom-shape file at
`src/resources/libraries/extra_shapes.csh` — is **generated** from the
[FortAwesome/Font-Awesome](https://github.com/FortAwesome/Font-Awesome)
submodule at `src/vendor/fontawesome`. Do not edit it by hand — run `./build.sh`.

Only `svgs/solid/` and `svgs/regular/` are read; `svgs/brands/` is skipped —
those are third-party company trademarks, not covered by Font Awesome's own
CC BY 4.0 grant for redistribution as generic icon shapes.

## Licence

Font Awesome Free icons are **CC BY 4.0**, © Fonticons, Inc. Full terms:
https://fontawesome.com/license/free

## How the conversion works

`convert.mjs` parses each icon's SVG `<path>` data directly into Photoshop
path-knot records (the same wire format `PathRecordCodec`/`ShapeFile` already
read and write) — real bezier curves, not a polygon flatten, including a full
SVG arc-to-cubic-bezier conversion. Icons with a hole (e.g. "circle") get
multiple subpaths chained so the picker's shared canvas fill combines them
into one evenodd fill; see the comment at the top of `convert.mjs`.

## Regenerating

```sh
git submodule update --remote src/vendor/fontawesome   # optional: pull newer upstream
src/vendor/js/fontawesome/build.sh
```

The generated file is committed so a fresh clone runs without rebuilding.
