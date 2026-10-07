# Upstream sync (PhotoCraft)

PhotoSuite is a modified version of [PhotoCraft](https://github.com/storytold/photocraft) (see
`NOTICE`). This file is the record of which upstream commits have been brought over and which
were decided against, and the procedure for doing it. `cargo xtask upstream` reads and writes it.

Synced through: `c34facea4d8329c39947fdf295495fb41025294b`

Every upstream commit up to and including that one is in PhotoSuite or was decided against.
(`a96a621` is the revision PhotoSuite was created from.)

## How a port works

PhotoSuite started as a copy of PhotoCraft's files, so the two repositories share no history.
`cargo xtask upstream port <sha>` builds, inside this repository and under the local
`refs/upstream/` namespace (never pushed), the upstream commit and its parent, holding only the
files the commit touches, renamed to PhotoSuite's names. Cherry-picking that onto our tree is a
real three-way merge with the upstream parent as the base, and the commit it prepares keeps the
upstream author, date and message, with the issue numbers pointing at PhotoCraft's tracker and a
`Ported-from: storytold/photocraft@<sha>` trailer. The trailer is how a commit counts as ported:
the ledger below only lists the commits decided against.

Renamed: `photocraft` → `photosuite` in every casing, and the app id `ai.storyteller.photocraft`
→ `io.github.eolix.PhotoSuite` (`app.photosuite` in the macOS bundle). Kept as they are:
attribution ("PhotoCraft contributors", ArtCraft), links to `storytold/photocraft` and
`photocraft-corpus`.

Never applied automatically (listed after the port for a person to look at):

- brand material (`docs/brand/`, `docs/images/`, `assets/app-icon/`): PhotoCraft's trademark
  terms; PhotoSuite has its own;
- `NOTICE`, the licences, `README.md`, `AGENTS.md`, `THIRD-PARTY-*`: PhotoSuite's own records;
- the translation catalogues (`crates/ui-egui/src/i18n/*.tsv`): PhotoSuite's translations are
  maintained separately; ask before taking upstream's rows;
- `.github/`: PhotoSuite's CI is set up differently.

## Procedure (for the session doing the sync)

1. `git -C ../photocraft fetch` (or `cargo xtask upstream status --fetch`), then
   `cargo xtask upstream status`: the undecided commits after the pin, oldest first, with a
   guess at their kind (fix / feature / chore) and how many of their files PhotoSuite has
   changed since ("diverged").
2. Take them in order. For each, decide:
   - **port** it (bug fixes, crash fixes, correctness; features only when asked):
     `cargo xtask upstream port <sha>`, with a clean working tree. Resolve conflicts in favour of
     PhotoSuite's behaviour where the two have diverged on purpose (the dialogs, Camera Raw,
     Cutout, …: see `git log` for why); look at the held-back files; build and run the tests
     the change needs (`AGENTS.md` §5); then hand over. The commit command is printed
     (`git commit -C <commit>`): the maintainer commits, not the session.
   - **skip** it: `cargo xtask upstream skip <sha> <reason>` (a feature not wanted, already
     done differently here, upstream-only infrastructure, …).
3. `cargo xtask upstream pin` after a batch moves "Synced through" past every decided commit.
4. Keep `NOTICE`, `THIRD-PARTY-NOTICES.md` and `THIRD-PARTY-CRATES.md` true for what a port
   brings in (a new asset needs its row; new crates need `packaging/notices/generate.sh`).

## Decisions

| Upstream | Decision | Note |
|---|---|---|
| `8713e26f5a` | skip | feature — Background layer: double-click, masks and cut behave like Photoshop (#266) (#266) |
| `b5b5ce8394` | skip | new UI language; translations maintained separately — i18n: add Simplified Chinese localization (#282) |
| `e5e2a8f2eb` | skip | feature — Enable dictionary segmentation for Japanese type (#250) (#250) |
| `eaf92dcd9d` | skip | feature — Smart Objects and Smart Filters survive PSD save and open (#288) (#288) |
| `7ee4bb2858` | skip | feature — Apply EXIF orientation on open, write Orientation = 1 on export (#285) (#318) (#318) |
| `e8677ff851` | skip | upstream CI/release infrastructure — Windows on ARM64: release builds, PE header check, install test on ARM64 hardware (#333) (#333) |
| `c046337ddf` | skip | feature — Move tool: Auto-Select on by default; a click picks and drags the layer under the pointer (#296) (#330) (#330) |
| `b6e9ec97e5` | skip | feature — Cmd+Enter (Ctrl+Enter) loads the path as a selection (#306) (#329) (#329) |
| `dd2f566daa` | skip | upstream CI/release infrastructure — macOS CLI: verify the shipped CLI is Developer ID signed and notarized in the release workflow (#308) (#320) (#320) |
| `321e986f7b` | skip | new UI language; translations maintained separately — i18n: add Traditional Chinese (zh-hant) UI catalog (#302) (#302) |
| `edc441a8d4` | skip | new UI language; translations maintained separately — Add a Spanish catalog (menus, dialogs, panels) (#299) (#299) |
| `abd6f6e591` | skip | new UI language; translations maintained separately — Localise the UI into Russian: a complete catalog and the missed tl! call sites (#298) (#298) |
| `b3c44cf070` | skip | feature — Preferences: add an Apply button (#325) (#325) |
| `5a6dd79852` | skip | new UI language; translations maintained separately — i18n: add Czech (cs) UI translation (#328) (#328) |
| `3b7870bee1` | skip | feature — Background jobs: engine job API, progress and cancel (part of #210) (#289) |
| `909efc0f6d` | skip | feature — Background jobs in the app: progress, Cancel, open-as-job (part of #210) (#373) |
| `0349b0c0f1` | skip | depends on skipped 7ee4bb2858 (EXIF orientation) — Harden EXIF orientation: limits after rotation, fallible allocation, strict IFD parsing (#345) (#345) |
| `c161eaec73` | skip | upstream font packaging infrastructure — Fonts: use craft-fonts as an optional build input; move the Japanese fonts out (#353) (#353) |
| `90a46d3f89` | skip | feature — Stamp Visible (Cmd+Alt+Shift+E) and Stamp Down; Alt+Merge keeps the originals (#217) (#356) (#356) |
| `0da7d4b0f5` | skip | feature — Right-click on the canvas lists the layers under the pointer (#307) (#360) (#360) |
| `fbcd0c238e` | skip | feature — Canvas scrollbars, and Preferences > Tools > Overscroll works (#300) (#367) (#367) |
| `0940f82d34` | skip | feature — Alt+right-drag resizes the brush and changes its hardness (#297) (#370) (#370) |
| `ba9272be7d` | skip | feature — Alt+scroll zooms the canvas in 5% steps around the pointer (#293) (#371) (#371) |
| `7930dd0adf` | skip | depends on skipped 3b7870bee1 (background jobs) — serve: `methods` lists jobs.list and jobs.cancel (#414) (#438) |
| `b926677549` | skip | feature — Alt-click with the Brush, Pencil, Gradient or Paint Bucket samples a colour (#417) (#450) |
| `6119c00962` | skip | feature — Layers panel: double-click beside a layer's name opens Layer Style (#350) (#452) |
| `3c6310e559` | skip | feature — New from Clipboard, and Paste with nothing open makes a document (#368) (#458) |
| `c8e0a34792` | skip | feature — Liquify remembers its brush settings between uses and launches (#418) (#461) |
| `58bfb4ee8c` | skip | feature — The main window opens centred on the screen (#419) (#462) |
| `f49b5a4853` | skip | feature — Keyboard layer navigation: Alt+[ / Alt+] / Alt+, / Alt+. and Shift to add (part of #352) (#470) |
| `f697e43ef7` | skip | feature — Transform Again on a Copy (Cmd+Alt+Shift+T): step and repeat (part of #352) (#474) |
| `93bd44899b` | skip | feature — Number keys set opacity, Shift+[ / Shift+] step hardness, Shift+Cmd+A opens Camera Raw (part of #352) (#473) |
| `a0997942d3` | skip | feature — Export: TGA in Save As and Export As (#363) (#377) |
| `1cb5af9218` | skip | upstream build configuration — Build desktop app by default (#425) |
| `7b3d131bc8` | skip | upstream docs — docs: correct VectorCraft sibling name (#429) |
| `d38eefc8f7` | skip | feature — Free Transform a Copy (Cmd+Alt+T); Esc takes the copy back (part of #352) (#482) |
| `5824e3afeb` | skip | upstream README — docs: add star history chart to README (#469) |
| `72e2eb9644` | skip | translations maintained separately — Spanish: add missing tool, filter and path translations (#488) |
| `4337a6227a` | skip | feature — Ctrl+Insert copies and Shift+Insert pastes on Linux; Shift+Insert pastes images on Windows (#531) |
| `29c280a2c6` | skip | upstream docs — Docs: roadmap, scorecard and README after the 2026-10-07 user-report fixes (#538) |
| `1df68e9a5d` | skip | feature — CLI batch: recorded-action steps, --format .ext, strict --quality, refuse --out = --in (#489, #490, #491, #492) (#545) |
| `8f0f95959d` | skip | depends on skipped 3b7870bee1 (background jobs) — Control channel: menu/dialog requests wait for their job; right-click menus at the point; MCP ui_pointer button (#510, #511, #512, #514) (#548) |
| `d9413cec0f` | skip | upstream CI/release infrastructure — FreeBSD CI: run the GPU integration tests one at a time (#576) |
| `8a8371395b` | skip | feature — Import warns when it keeps only the first frame or page, or a JPEG ends early (#518, #523) (#563) |
| `51d85c1170` | skip | upstream CI/release infrastructure — Linux: AppImage update information and a .zsync beside it (#349) (#399) |
| `06b0ad7af0` | skip | feature — Color Picker and Color panel fields accept typed values (#485) |
| `60224d3fb7` | skip | upstream CI/release infrastructure — Release 0.3.0 (#577) |
| `eb2fb2634f` | skip | feature — Add rendering modes and CPU fallback recovery (#434) |
| `9f0c049b53` | skip | feature — Unsaved-changes prompt: (D)on't Save / (C)ancel / (S)ave keys, Tab order (#533) |
| `b41442c466` | skip | feature — Color Picker: sample colours from the image with a pipette (#508) |
| `25d198ceb1` | skip | feature — Free Transform: Undo steps through the transform; handles are easier to grab (#365) |
| `da9adf82bc` | skip | rustfmt for skipped 9f0c049b53 — rustfmt discard_ui.rs (CI Format step red since #533) (#597) |
| `48bd08150e` | skip | feature — feat(ui): add bounded Liquify redo history (#435) |
| `bd7d47bf0f` | skip | feature — Lasso inside liquify mode , with hotkeys L, alt , ctrl+i, ctrl+h for … (#453) |
| `d91ab25772` | skip | feature — Expose the Mixer Brush as a UI tool (#213) (#433) |
| `6422219226` | skip | upstream docs — Control protocol docs: file.open and file.save are refused over --control (#391) |
| `45d0f4ad93` | skip | upstream docs — docs: sync scorecard with implemented behavior (#348) |
| `2c02d41eaf` | skip | feature — Show active ICC profile in the status bar (#321) (#432) |
| `50d52a0848` | skip | feature — Clarify integer and float bit-depth labels (#324) (#428) |
| `047aeb747a` | skip | feature — Wayland: explain native file drag-and-drop limitation (#386) (#430) |
| `bf545e0e81` | skip | feature — Hide unconfigured layer effects from panel (#559) |
| `0cb27712c8` | skip | feature — Paste: a copied image file pastes its pixels (part of #338) (#384) |
| `7dc1575efc` | skip | feature (performance) — Content-Aware Scale: 13x faster seam removal, bit-identical output (part of #211) (#385) |
| `fbe5f80ba4` | skip | depends on skipped eaf92dcd9d (smart objects in PSD) — PSD: read smart-filter masks (FEid) with one section per smart object (#396) |
| `cc5de414dc` | skip | feature (Camera Raw diverged on purpose) — Camera Raw: interactive histogram, clipping warnings and scopes (part of #215) (#407) |
| `b4f9d56c93` | skip | feature — Add the Patch tool with a live preview (#213) (#381) |
| `8aecbffb5c` | skip | feature — Add blend modes to Gradient tool (#543) |
| `b5eed81a25` | skip | feature — Start context-menu parity across canvas, paths, and document tabs (#556) |
| `b45dfde498` | skip | translations maintained separately — i18n: complete Simplified Chinese catalog and localize brush sections (#359) |
| `a4e96991f1` | skip | new UI language; translations maintained separately — i18n: add French (fr) UI translation (#410) |
| `786a863f9c` | skip | new UI language; translations maintained separately — i18n: "id" indonesian translation (#449) |
| `90df9cfc15` | skip | feature — Report per-language UI translation coverage (#220) (#427) |
| `fa0defc56b` | skip | feature — Add style warp splits and grid presets (#388) |
| `8ebca04aa9` | skip | feature — Add Edit Contents to Smart Object context menu (#599) |
| `3d23a708c2` | skip | feature — Edit type layers by double-clicking their thumbnails (#598) |
| `45bedb0962` | skip | feature — Monitor profile auto follows each window's display; what is applied is visible (#569) (#591) |
| `d4086ba11a` | skip | feature — feat(i18n): add Korean and live language switching (#582) |
| `e77325bd4a` | skip | feature — Add fixed UI scale steps from 75% to 300% (#611) |
| `b07a2e5b43` | skip | feature — Remember desktop window and panel sizes across restarts (#587) |
| `2cd470c08e` | skip | depends on skipped 45bedb0962 (monitor profile) — monitor_profile test: Unix only (it runs /bin/sleep and /bin/sh); fixes Windows CI after #591 (#633) |
| `7055f0c51b` | skip | upstream README — README: remove a stray "ArtCraft" line before Star history (#636) |
| `47f9306fd0` | skip | already done differently here (fe404f6 HEIC decoding) — Open HEIC/HEIF photos (#355) (#372) |
| `d7df9d8aa6` | skip | upstream docs — Rename PrintCraft to PdfCraft (storytold/pdfcraft) (#766) |
| `e79dcb6f7f` | skip | new UI language; translations maintained separately — i18n: add German (de) UI translation (#309) (#663) |
| `fc00f1e5bc` | skip | upstream scorecard docs — scorecard: BUG-203 (atomic saves) is done - flip the stale rows (#203) (#687) |
| `d5923e49db` | skip | feature — layer.showOnly: ⌥-click a layer's eye to show only that layer (#665) |
| `9270a31f24` | skip | feature (performance) — Box Blur: running sums, so large radii cost the same as small ones (#628) |
| `43c86ef645` | skip | feature — Layers panel: drag down the eyes to show or hide layers; empty eye when hidden (#666) |
| `09b6572578` | skip | feature (performance) — Minimum/Maximum (Squareness): running extremes, bit-identical (#630) |
| `3a3984075a` | skip | feature (performance) — Surface Blur: 13x to 40x+ faster on 8-bit layers (sliding histogram) (#631) |
| `7f486d723f` | skip | feature — Add Layer Remove Background command (#734) |
| `8d8ea584b8` | skip | new UI language; translations maintained separately — Brazilian Portuguese UI translation (pt-br) (#700) |
| `9aef02cac3` | skip | feature — macOS: menus open on press; only the title bar's free gap drags the window (#669) |
| `6c4010cfc4` | skip | feature — Color panel: click a chip to edit that color, double-click to open the Color Picker (#655) (#664) |
| `2cdff3afb9` | skip | feature — feat(ui): numeric fields evaluate typed arithmetic (#726) |
| `a62b6473f3` | skip | feature — Transform modes: Skew / Distort / Perspective as real modes; legacy corners as a preference (#671) |
| `06ec4044ea` | skip | translations maintained separately — Improve Korean terminology and dynamic UI translation coverage (#604) |
| `9d46c8ea80` | skip | feature — Arbitrary rotation starts at the ruler line's straightening angle (#660) |
| `6103da5278` | skip | rustfmt for skipped i18n coverage work — rustfmt xtask/src/i18n_coverage.rs (Format red on main since #663 + #700) (#798) |
| `107ffe9127` | skip | feature — codecs: decode deep OpenEXR (deepscanline/deeptile), composited flat or structured (#642) |
| `6c7d01a0f3` | skip | feature — Selections: drag to move the outline; ⌘-drag floats the selected pixels (engine commands) (#686) |
| `b70bf524ea` | skip | feature — Filter › Render › Relight: redirect a photo's lighting (#735) |
| `f46c462129` | skip | rustfmt for skipped 107ffe9127 — rustfmt crates/codecs/tests/deep_exr.rs (Format red on main since #642) (#804) |
| `9e88c65d33` | skip | feature — Support Alt-held polygon segments in the freehand lasso (#711) |
| `2baa95d684` | skip | feature — Type: hitTest, caret and navigate commands so agents can edit text by position (part of #219) (#623) |
| `7080e6c56a` | skip | translations maintained separately — Korean labels for Relight's Ambient and Warmth options (#811) |
| `bd632e7eb3` | skip | feature — Layered TIFF: open and save Photoshop layer data in TIFF files, in either byte order (part of #215) (#672) |
| `4a0a8d0794` | skip | feature — Actions: actions.record/stop/play/list commands for agents and the CLI (part of #219) (#622) |
| `83ace1138e` | skip | rustfmt for skipped 9e88c65d33 — rustfmt crates/ui-egui/src/canvas.rs (Format red on main since #711) (#819) |
| `6ee3e4f752` | skip | feature — Flat exports embed no document XMP by default; Export As gains a Metadata choice (#647) (#733) |
| `e1cf321183` | skip | rustfmt for skipped bd632e7eb3/6ee3e4f752 — rustfmt crates/ui-egui/src/export_dialog.rs (Format red on main since #672 + #733) (#822) |
| `15af216bd1` | skip | feature — Follow-ups to #665, #666, #734: Photoshop's mask-only Remove Background, one-step eye sweep, no-clone Show Only (#824) |
| `41e9c742dc` | skip | feature — Headless saves write a flat TIFF unless they ask for layers (#825) |
| `03ffca0d54` | skip | feature — Dialog buttons follow the OS order; Windows/Linux unsaved prompt asks Yes / No / Cancel (#627, #776) (#826) |
| `4b3da49486` | skip | feature (Camera Raw diverged on purpose) — Camera Raw: read and write settings as a live PSD Smart Filter (part of #215) (#459) |
| `684f85e2e5` | skip | feature — ⌘⌥⌃-click on the canvas selects the topmost layer under the pointer (#813) |
| `a20c63521d` | skip | feature — Help › Search: find any menu command by name (#815) |
| `25f211500b` | skip | translations maintained separately — i18n(ko): drop the duplicate Ambient and Warmth rows (main red since #811 + #824) (#834) |
| `c887ed94cc` | skip | feature — Add the Content-Aware Move tool (#213) (#814) |
| `f9479063be` | skip | feature (Camera Raw diverged on purpose) — Rework Camera Raw filter preview and navigation (#781) |
| `0675a253dd` | skip | feature — M9: create vertical type from the Type tool flyout (#784) |
| `2a2459f57a` | skip | feature — Drag-and-drop: place onto the canvas in Free Transform, open at a tab slot (#739) |
| `b436950ae3` | skip | feature — Layer Style: complete multi-instance effects and dialog parity (#157) (#786) |
| `7a9b591189` | skip | new UI language; translations maintained separately — Italian UI translation (it) (#853) |
| `b6f5df3b3f` | skip | feature — pcraft directory saves: re-verify a rolling share of cached objects; stronger file signature (#821) |
