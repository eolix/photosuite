# Upstream sync (PhotoCraft)

PhotoSuite is a modified version of [PhotoCraft](https://github.com/storytold/photocraft) (see
`NOTICE`). This file is the record of which upstream commits have been brought over and which
were decided against, and the procedure for doing it. `cargo xtask upstream` reads and writes it.

Synced through: `7a9b5911893c958c5ac10efb148aa2d325c6a7f2`

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

- everything under `docs/`: PhotoSuite writes its own documentation (upstream's roadmap,
  scorecard and the rest are not taken), and upstream's `docs/brand/` and `docs/images/` are
  PhotoCraft's trademark material;
- `assets/app-icon/`: PhotoCraft's brand; PhotoSuite has its own;
- `NOTICE`, the licences, `README.md`, `AGENTS.md`, `THIRD-PARTY-*`: PhotoSuite's own records;
- everything under `crates/ui-egui/src/i18n/`: PhotoSuite manages its own translations;
- `.github/`: PhotoSuite's CI is set up differently.

## Rules for every port

- **Commit subjects** are `<type>: <description>`, the type one of `feat`, `fix`, `chore`,
  `docs`, `nit`. `upstream port` writes them that way.
- **No UI changes**: nothing from upstream changes how PhotoSuite looks (modals and dialogs,
  sizes, layout, fonts, colours, themes, icons). Behaviour and fixes in UI code are taken; the
  visual parts of a port are reverted, or the commit is skipped when it is mostly visual.
- **Nothing under `docs/`** is taken (see above).
- **Themes are PhotoSuite's**: upstream's theme names are mapped onto PhotoSuite's by role
  (Pro → Midnight, ProMedium → Slate, Studio and Classic → Anthracite, StudioLight → Pearl);
  `upstream port` does it in Rust sources, the rest by hand. Upstream palette changes are never
  taken.
- **No translations**: upstream's catalogues, languages and i18n code are never taken; PhotoSuite
  manages its own. Translation commits are skipped.

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
| `b5b5ce8394` | skip | new UI language; translations maintained separately — i18n: add Simplified Chinese localization (#282) |
| `e8677ff851` | skip | upstream CI/release infrastructure — Windows on ARM64: release builds, PE header check, install test on ARM64 hardware (#333) (#333) |
| `dd2f566daa` | skip | upstream CI/release infrastructure — macOS CLI: verify the shipped CLI is Developer ID signed and notarized in the release workflow (#308) (#320) (#320) |
| `321e986f7b` | skip | new UI language; translations maintained separately — i18n: add Traditional Chinese (zh-hant) UI catalog (#302) (#302) |
| `edc441a8d4` | skip | new UI language; translations maintained separately — Add a Spanish catalog (menus, dialogs, panels) (#299) (#299) |
| `5a6dd79852` | skip | new UI language; translations maintained separately — i18n: add Czech (cs) UI translation (#328) (#328) |
| `7b3d131bc8` | skip | upstream docs — docs: correct VectorCraft sibling name (#429) |
| `5824e3afeb` | skip | upstream README — docs: add star history chart to README (#469) |
| `72e2eb9644` | skip | translations maintained separately — Spanish: add missing tool, filter and path translations (#488) |
| `d9413cec0f` | skip | upstream CI/release infrastructure — FreeBSD CI: run the GPU integration tests one at a time (#576) |
| `51d85c1170` | skip | already done here (6145804 AppImage update channel and verification) — Linux: AppImage update information and a .zsync beside it (#349) (#399) |
| `60224d3fb7` | skip | upstream CI/release infrastructure — Release 0.3.0 (#577) |
| `cc5de414dc` | skip | clashes with PhotoSuite's own Camera Raw histogram (ccb44c3) — Camera Raw: interactive histogram, clipping warnings and scopes (part of #215) (#407) |
| `b45dfde498` | skip | translations maintained separately — i18n: complete Simplified Chinese catalog and localize brush sections (#359) |
| `a4e96991f1` | skip | new UI language; translations maintained separately — i18n: add French (fr) UI translation (#410) |
| `786a863f9c` | skip | new UI language; translations maintained separately — i18n: "id" indonesian translation (#449) |
| `7055f0c51b` | skip | upstream README — README: remove a stray "ArtCraft" line before Star history (#636) |
| `47f9306fd0` | skip | already done differently here (fe404f6 HEIC decoding) — Open HEIC/HEIF photos (#355) (#372) |
| `d7df9d8aa6` | skip | upstream docs — Rename PrintCraft to PdfCraft (storytold/pdfcraft) (#766) |
| `e79dcb6f7f` | skip | new UI language; translations maintained separately — i18n: add German (de) UI translation (#309) (#663) |
| `8d8ea584b8` | skip | new UI language; translations maintained separately — Brazilian Portuguese UI translation (pt-br) (#700) |
| `7080e6c56a` | skip | translations maintained separately — Korean labels for Relight's Ambient and Warmth options (#811) |
| `25f211500b` | skip | translations maintained separately — i18n(ko): drop the duplicate Ambient and Warmth rows (main red since #811 + #824) (#834) |
| `7a9b591189` | skip | new UI language; translations maintained separately — Italian UI translation (it) (#853) |
| `abd6f6e591` | skip | translations maintained separately — Localise the UI into Russian: a complete catalog and the missed tl! call sites (#298) (#298) |
| `90df9cfc15` | skip | translations maintained separately — Report per-language UI translation coverage (#220) (#427) |
| `d4086ba11a` | skip | translations maintained separately — feat(i18n): add Korean and live language switching (#582) |
| `06ec4044ea` | skip | translations maintained separately — Improve Korean terminology and dynamic UI translation coverage (#604) |
| `6103da5278` | skip | translations maintained separately — rustfmt xtask/src/i18n_coverage.rs (Format red on main since #663 + #700) (#798) |
| `2cbb13a79d` | skip | translations maintained separately — fix(i18n): follow native UI languages on first launch (#661) |
| `58bfb4ee8c` | skip | UI change (no UI changes from upstream) — The main window opens centred on the screen (#419) (#462) |
| `a0d49de047` | skip | UI change (no UI changes from upstream) — Menus stay above the taskbar; oversized windows open maximized (#315) (#343) (#343) |
| `778e8e187d` | skip | UI change (no UI changes from upstream) — Image Size shows the one-pixel minimum it applies (#441) (#468) |
| `4fdb71dfc3` | skip | UI change: PhotoSuite's own dialog frame (bb936e1) — Dialogs keep their top-left when their content resizes (#487) |
| `047aeb747a` | skip | UI change (no UI changes from upstream) — Wayland: explain native file drag-and-drop limitation (#386) (#430) |
| `bf545e0e81` | skip | UI change (no UI changes from upstream) — Hide unconfigured layer effects from panel (#559) |
| `9f0c049b53` | skip | UI change: PhotoSuite's own dialogs — Unsaved-changes prompt: (D)on't Save / (C)ancel / (S)ave keys, Tab order (#533) |
| `da9adf82bc` | skip | rustfmt for skipped 9f0c049b53 — rustfmt discard_ui.rs (CI Format step red since #533) (#597) |
| `3f637410cb` | skip | UI change (no UI changes from upstream) — Apply the Interface UI Font Size preference (#616) |
| `9aef02cac3` | skip | UI change: PhotoSuite's own title bar (b932800) — macOS: menus open on press; only the title bar's free gap drags the window (#669) |
| `6ee3e4f752` | skip | UI change: Export As dialog — Flat exports embed no document XMP by default; Export As gains a Metadata choice (#647) (#733) |
| `e1cf321183` | skip | rustfmt for skipped 6ee3e4f752 — rustfmt crates/ui-egui/src/export_dialog.rs (Format red on main since #672 + #733) (#822) |
| `f9479063be` | skip | UI change: PhotoSuite's own Camera Raw — Rework Camera Raw filter preview and navigation (#781) |
| `a20c63521d` | skip | UI change (new search palette) — Help › Search: find any menu command by name (#815) |
| `c161eaec73` | skip | fonts (no UI changes from upstream) — Fonts: use craft-fonts as an optional build input; move the Japanese fonts out (#353) (#353) |
| `b07a2e5b43` | skip | already done here (persist_window in apps/photosuite main.rs) — Remember desktop window and panel sizes across restarts (#587) |
| `52ccb8a800` | skip | already done here (73b748d canvas close button based on OS) — Document tab close button after the title on Windows and Linux, as in Photoshop (#619) (#832) |
| `244a99c39f` | skip | UI change: PhotoSuite's own title bar (b932800) — Windows and Linux: one title bar with the app icon (no stacked OS bar); long context menus scroll (#986) |
| `735bb09a98` | skip | already done differently here (lossy WebP via webp-rust, quality kept per document) — Lossy WebP: a pure-Rust VP8 encoder with quality and lossless controls (#648) (#880) |
| `3f605afc81` | skip | UI change (menu row sizes) — Menu rows touch, as in native menus: long menus are a fifth shorter (#402) (#844) |
| `44303db546` | skip | UI change: About dialog (PhotoSuite's own) — About: contributor and model credits compiled in (grab bag + table, self-submitted names) (#898) |
| `0f16bce0c5` | skip | already done differently here (PhotoSuite's own Magnetic Lasso, magnetic_ui.rs) — Add the Magnetic Lasso tool (#864) |
| `07174271d5` | skip | only held-back files (translations / CI / brand / records) — CI: never cancel main's runs; trim per-PR runner time (#800) |
| `00c406f589` | skip | tests behaviour from skipped 9aef02cac3 (menus open on press) — Test: one press-drag-release gesture crosses menu titles and enters submenus (#775) (#837) |
| `1d8a32ed83` | skip | only held-back files (translations / CI / brand / records) — Release CI: macOS job on the org macos-release runner |
| `34a87cedea` | skip | only held-back files (translations / CI / brand / records) — actionlint: declare the org macos-release runner label (#927) |
| `e040376e15` | skip | only held-back files (translations / CI / brand / records) — Release CI: macOS job on macos-15-xlarge |
