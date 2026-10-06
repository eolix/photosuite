# Third-party notices

This project is licensed under the MIT License or the Apache License, Version 2.0, at your option
— see [`LICENSE-MIT`](LICENSE-MIT), [`LICENSE-APACHE`](LICENSE-APACHE) and [`NOTICE`](NOTICE). It
is built on [PhotoCraft](https://github.com/storytold/photocraft) (see below and `NOTICE`).

This file collects the attribution and licence notices for the third-party works in the source
tree and in the distributed application. It is packaged with the application, so a recipient of
a binary has it without going back to the repository.

## Where the full licence texts are

Every bundled third-party work keeps its licence text next to it:

| Directory | Licence file |
|---|---|
| `assets/fonts/` | `OFL-Inter.txt`, `OFL-JetBrainsMono.txt` |
| `assets/icons/` | `LICENSE-lucide.txt` |
| `assets/dict/` | `LICENSE-SCOWL.txt` |
| `assets/ico/` | `LICENSE` |
| `resources/luts/` | `LICENSE` |
| `resources/lensfun/` | `LICENSE-CC-BY-SA-3.0.txt` |
| `resources/gradients/` | `LICENSE-uigradients.txt` |
| `resources/brushes/` | `LICENSE-brusheezy-brushes.txt` |
| `resources/patterns/` | `LICENSE-subtlepatterns.txt` |
| `resources/shapes/` | `LICENSE-fontawesome.txt` |

A new third-party file gets its licence beside it and a row below, in the same change.

---

## MIT OR Apache-2.0 — PhotoCraft

The engine, document model, codecs and UI framework of this application come from
[PhotoCraft](https://github.com/storytold/photocraft), © 2026 ArtCraft Team and the PhotoCraft
contributors, licensed under MIT OR Apache-2.0. The attribution and the statement of changes
required by Apache-2.0 §4 are in [`NOTICE`](NOTICE).

## SIL Open Font License 1.1 — Inter, JetBrains Mono

The interface fonts [Inter](https://github.com/rsms/inter) (© The Inter Project Authors) and
[JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) (© The JetBrains Mono Project
Authors). Full texts: `assets/fonts/OFL-Inter.txt`, `assets/fonts/OFL-JetBrainsMono.txt`.

## MIT — Tabler Icons

Most of the interface icons in `assets/ico/` are derived from
[Tabler Icons](https://github.com/tabler/tabler-icons), © 2020–2026 Paweł Kuna. The rest are drawn
for this application. Full text: `assets/ico/LICENSE`.

## ISC and MIT — Lucide, Feather

The remaining interface icons in `assets/icons/` are [Lucide](https://github.com/lucide-icons/lucide)
(ISC, © Lucide Icons and Contributors); some derive from
[Feather](https://github.com/feathericons/feather) (MIT, © Cole Bemis). Full text:
`assets/icons/LICENSE-lucide.txt`.

## SCOWL — English word list

`assets/dict/en_US-scowl-50.txt.gz`, used by Check Spelling, is built from
[SCOWL](http://wordlist.aspell.net/), © Kevin Atkinson and the SCOWL contributors, under the
SCOWL licence. Full text and build recipe: `assets/dict/LICENSE-SCOWL.txt`.

## MIT — uiGradients

`resources/gradients/uigradients.grd` is generated from
[uiGradients](https://github.com/ghosh/uiGradients) (382 community-contributed gradients),
© 2017 Indrashish Ghosh. Full text: `resources/gradients/LICENSE-uigradients.txt`.

## Creative Commons Attribution 4.0 — Font Awesome Free

`resources/shapes/shapes.csh` is generated from the Font Awesome Free `solid` and
`regular` icons, © Fonticons, Inc., licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The `brands` icons are excluded:
they depict third-party trademarks. Notice: `resources/shapes/LICENSE-fontawesome.txt`.

## Creative Commons Attribution-ShareAlike 3.0 — Subtle Patterns

`resources/patterns/patterns.pat` (the seed set) and
`resources/patterns/extra_patterns.pat` are from
[Subtle Patterns](https://github.com/atlemo/SubtlePatterns), © Toptal, with individual patterns
credited to their designers there. Licensed under
[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/): an adaptation must carry the same
licence. Notice: `resources/patterns/LICENSE-subtlepatterns.txt`.

## Creative Commons Attribution-NoDerivatives and Attribution-ShareAlike — Brusheezy brushes

Three brush libraries from [Brusheezy](https://www.brusheezy.com), each under its own terms:

| File | Artist | Licence |
|---|---|---|
| `resources/brushes/Markers.abr` | brushchick | CC BY-ND — **must not be modified** |
| `resources/brushes/Paintbrush_Set.abr` | lovelace | CC BY-ND — **must not be modified** |
| `resources/brushes/Pencil_Scribbles.abr` | stuffwemake | CC BY-SA — an adaptation must carry the same licence |

All three are byte-identical to the upstream downloads. Sources and terms:
`resources/brushes/LICENSE-brusheezy-brushes.txt`.

## CC0 — Fresh LUTs

The Color Lookup presets in `resources/luts/*.CUBE` are from [Fresh LUTs](https://freshluts.com),
dedicated to the public domain under CC0. No attribution is required; this row is kept so the
source is on record. Notice: `resources/luts/LICENSE`.

## CC BY-SA 3.0 — Lensfun lens database

`resources/lensfun/lens-database.json` holds the lens profiles Filter › Lens Correction's Auto
profiles use. It is an adaptation (XML converted to JSON, non-English display names dropped) of
the [Lensfun](https://github.com/lensfun/lensfun) database at commit `23e8cb8`, by the Lensfun
contributors, and is distributed under the same licence, CC BY-SA 3.0. Only the data is used, not
Lensfun's LGPL library, and PhotoSuite's code is a separate work. Licence:
`resources/lensfun/LICENSE-CC-BY-SA-3.0.txt`; details in `resources/lensfun/README.md`.

## BSD-3-Clause and CC0 — data inside the PDF renderer

The `hayro` crate (Apache-2.0 OR MIT), which opens PDFs, compiles in two kinds of data:
- the Foxit standard fonts (`FoxitSans*.pfb`, `FoxitSerif*.pfb`, `FoxitFixed*.pfb`,
  `FoxitSymbol.pfb`, `FoxitDingbats.pfb`), © 2014 PDFium Authors, BSD-3-Clause. They draw PDFs
  that don't embed their standard fonts.
- a CGATS CMYK profile (CC0) and a Lab profile.

The licence texts are in the crate source (`hayro-interpret/assets/LICENSE_FOXIT`,
`CGATS_LICENSE.txt`). The BSD notice has to travel with binaries; it belongs in the generated
crate notices (see "Not yet resolved").

## CC0 — generated colour data

`crates/cms/profiles/photosuite-coated-cmyk.icc` and the other built-in ICC profiles and generated
looks are produced by code (`crates/cms/src/synth.rs`, `builtin.rs`, `lutfile.rs`) and dedicated to
the public domain.

---

## Per-file index

| Path | What | Author | Licence |
|---|---|---|---|
| `assets/fonts/Inter-{Regular,Medium,SemiBold}.ttf` | Inter 4.001, UI font | The Inter Project Authors | OFL 1.1 |
| `assets/fonts/JetBrainsMono-Regular.ttf` | JetBrains Mono 2.305, numeric font | The JetBrains Mono Project Authors | OFL 1.1 |
| `assets/icons/*.svg`, except the three below | Lucide icons | Lucide Icons and Contributors | ISC |
| `assets/icons/{check,chevron-*,chevrons-*,circle,clock,compass,info,link,lock,minus,moon,move,navigation,plus,search,square,trash,triangle,type,x,zoom-in}.svg` | Lucide icons derived from Feather | Cole Bemis; Lucide Contributors | MIT and ISC |
| `assets/icons/slice-knife.svg` | Slice tool glyph | PhotoCraft contributors | MIT OR Apache-2.0 |
| `assets/icons/eraser-{background,magic}.svg` | Lucide `eraser` with added marks | Lucide Contributors; PhotoCraft contributors | ISC |
| `assets/app-icon/` | Application icon: the PhotoSuite logo | The PhotoSuite authors | MIT OR Apache-2.0 |
| `assets/dict/en_US-scowl-50.txt.gz` | English word list | Kevin Atkinson and the SCOWL contributors | SCOWL |
| `assets/ico/**/*.svg`, most | Tabler Icons | Paweł Kuna | MIT |
| `assets/ico/tools/{blur,brush,camove,corner,crepl,fpen,gradient,hbrush,mlasso,oselect,patch,pen,plasso,qselect,redeye,shbrush,sponge}.svg` | Tool glyphs drawn for this app | The PhotoSuite authors | MIT OR Apache-2.0 |
| `assets/img/icon_full.{svg,png}` | PhotoSuite logo | The PhotoSuite authors | MIT OR Apache-2.0 |
| `resources/luts/*.CUBE` (45) | Color Lookup presets | Fresh LUTs uploaders | CC0 |
| `resources/lensfun/lens-database.json` | Lens profiles (adapted from the Lensfun database) | The Lensfun contributors | CC BY-SA 3.0 |
| `resources/gradients/uigradients.grd` | Gradient library (the Gradients panel's uiGradients group) | uiGradients contributors | MIT |
| `resources/shapes/shapes.csh` | Custom shape library | Fonticons, Inc. | CC BY 4.0 |
| `resources/patterns/extra_patterns.pat`, `resources/patterns/patterns.pat` | Pattern libraries | Subtle Patterns designers | CC BY-SA 3.0 |
| `resources/brushes/{Markers,Paintbrush_Set}.abr` | Brush libraries | brushchick; lovelace | CC BY-ND |
| `resources/brushes/Pencil_Scribbles.abr` | Brush library | stuffwemake | CC BY-SA |
| `crates/cms/profiles/photosuite-coated-cmyk.icc` | Synthetic CMYK profile | PhotoCraft contributors | CC0 |

## Test data — not shipped

`corpus/` is gitignored and never committed. `cargo xtask corpus --all` fetches each corpus at the
pins in `xtask/src/corpus_pins.rs`, verifies it against `xtask/*.sha256`, and places its licence
next to the files.

| Path (fetched) | What | Licence |
|---|---|---|
| `corpus/photoshop/` | Photoshop oracle corpus, from [photocraft-corpus](https://github.com/storytold/photocraft-corpus) | MIT OR Apache-2.0 |
| `corpus/psd-tools/` | psd-tools test set, © 2019 Kota Yamaguchi | MIT |
| `corpus/psd/` | Selection from psd-tools and [ag-psd](https://github.com/Agamnentzar/ag-psd) | MIT |
| `corpus/pngsuite/` | [PngSuite](http://www.schaik.com/pngsuite/), Willem van Schaik | Public domain |

Files copied into `corpus/` by hand must be MIT, BSD or CC0.

---

## Rust crates

The Rust crates linked into the binaries are under their own licences (overwhelmingly MIT and/or
Apache-2.0). [`THIRD-PARTY-CRATES.md`](THIRD-PARTY-CRATES.md) lists every one with its licence
text; it is generated from `Cargo.lock` by `packaging/notices/generate.sh` and ships in every
package beside this file.
