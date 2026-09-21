# Icon set

Single-colour SVG icons for the app chrome. Most are derived from
[Tabler Icons](https://github.com/tabler/tabler-icons) (MIT — see `LICENSE`);
the rest are drawn for this app.

## Layout

Files mirror the logical icon keys in `src/assets/icon-registry.js`: the key
`tools/brush` is the file `tools/brush.svg`.

## Colour

Icons are loaded as plain image URLs (`<img src>` and CSS `background-image`),
where the SVG is its own document and cannot inherit page colour. Each file
therefore carries a black stroke, and the theme tints it through
`filter: invert(var(--gs-invert))` — the `gsicon` class in `style/all.css`.

## Weight

Icons are 24×24, drawn at 20px in the tool strip and 12–15px in layer rows, so
they render at 0.5–0.83 scale. The set is emitted at `stroke-width` 1.25, which
lands near 1px on screen and sits with the weight of the surrounding chrome. To
move the whole set to another weight:

```sh
find src/assets/ico -name '*.svg' \
  -exec sed -i '' 's/stroke-width="1.25"/stroke-width="1.5"/' {} +
```

A few icons are filled rather than stroked and carry no `stroke-width`.
`tools/pselect` is the solid arrow so it reads distinctly from the outlined
`tools/dselect`, as in Photoshop.

## Adding an icon

Put the SVG at `src/assets/ico/<key>.svg`, matching the key exactly. An icon
taken from Tabler needs three edits first:

- remove the metadata comment header;
- change `stroke="currentColor"` / `fill="currentColor"` to `#000`;
- set `stroke-width` to 1.25.

`npm test` checks that every key in the registry resolves to a file that exists,
and that every SVG here is the icon its key resolves to.
