# Icon set

Single-colour SVG icons for the app chrome. Most are derived from
[Tabler Icons](https://github.com/tabler/tabler-icons) (MIT — see `LICENSE`); the rest were drawn
for PhotoSuite (see THIRD-PARTY-NOTICES.md).

## Layout

`assets/ico/<group>/<name>.svg` is the icon `<group>-<name>` in the app (`tools/brush.svg` is
`tools-brush`). The table that embeds them, `crates/ui-egui/src/icon_data.rs`, is generated:

```sh
python3 scripts/gen-icon-table.py
```

## Colour

Files carry black strokes or fills. `crates/ui-egui/src/icons.rs` recolours them for the theme
when they are rasterised, so an icon needs no theme-specific variants.

## Weight

Icons are 24×24 with `stroke-width` 1.25, which lands near 1 px on screen at the sizes the
toolbar and panels draw them. A few icons are filled rather than stroked and carry no
`stroke-width`; `tools/pselect` is the solid arrow so it reads distinctly from the outlined
`tools/dselect`, as in Photoshop.

## Adding an icon

Put the SVG at `assets/ico/<group>/<name>.svg` and regenerate the table. An icon taken from
Tabler needs three edits first:

- remove the metadata comment header;
- change `stroke="currentColor"` / `fill="currentColor"` to `#000`;
- set `stroke-width` to 1.25.
