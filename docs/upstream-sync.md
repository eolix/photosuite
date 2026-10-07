# Upstream sync (PhotoCraft)

PhotoSuite is a modified version of [PhotoCraft](https://github.com/storytold/photocraft) (see
`NOTICE`). This file is the record of which upstream commits have been brought over and which
were decided against, and the procedure for doing it. `cargo xtask upstream` reads and writes it.

Synced through: `a96a621deea97d4b1ecd173b8b921587e33f3ca5`

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
