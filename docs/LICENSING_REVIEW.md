# Repository licensing review

Review date: 2026-09-24. Current upstream revision:
`0b89b92c412a281a73e24d9c483e785133890c9d`.

Upstream now includes the GNU GPL version 3 text in [LICENSE](../LICENSE), added
by commit `0b89b92`. The initial review examined `768cc9f`; the only change between
these revisions is the new license file, so the code comparisons below still
apply. `package.json` and both project `Cargo.toml` files have no license
declaration. This review records a licensing proposal and findings for maintainer
discussion. It does not grant, replace, or change any license.

**Proposal: consider standard Apache-2.0 for broader downstream reuse**, including
proprietary derivatives, for code the maintainers have authority to license.
It permits that reuse and includes an express contributor patent grant, limited
to qualifying contributor patent claims. MIT is another permissive option.
This would be a deliberate policy change from GPLv3, whose copyleft generally
requires distributed derivative programs to retain GPL terms and provide
corresponding source. Retaining GPLv3 is appropriate if that is the maintainers'
intention; dependency compatibility alone does not require choosing Apache.
Any change needs the relevant rights holders' authority.
[Apache-2.0 terms](https://www.apache.org/licenses/LICENSE-2.0),
[GPLv3 terms](https://opensource.org/license/gpl-3.0).

An Apache setup would use the unchanged license text in `LICENSE`, preserve
upstream license files, and identify third-party components and their licenses
in `THIRD_PARTY_NOTICES.md`. The README should explain which material the project
license covers. These notices document separate licenses; they do not modify
Apache-2.0 or supply missing permissions. GitHub recommends keeping the primary
license file simple and documenting additional complexity elsewhere.
[GitHub guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository#detecting-a-license).

The following inventory draws on local license texts, embedded font metadata,
vendor build documentation, and selected upstream files at pinned revisions.
It is not a complete release-compliance audit.

| Material | License evidence | Implication |
|---|---|---|
| Most vendored JavaScript libraries; Tabler icons | MIT | Retain upstream copyright and permission notices. |
| pdf.js image codecs | Apache-2.0 | Preserve license, applicable notices, and modification information. |
| HarfBuzz; libwebp; zstd; stb_image | Old MIT; BSD-3-Clause; BSD-3-Clause selected from dual licensing; MIT/public-domain alternatives | Permissive terms, with their respective notice requirements. |
| FriBidi | LGPL-2.1-or-later according to vendor provenance | Preserve library source and modification/replacement rights. |
| libheif and statically included libde265 | LGPL-3.0-or-later according to vendor provenance | Provide corresponding library source, required notices, and a working recombination route. |
| Lensfun generated database | CC BY-SA 3.0 | Preserve database attribution and ShareAlike terms separately from the application. |
| Four Noto fonts | OFL-1.1 in embedded metadata | Fonts retain OFL; distribute required copyright and full license text. |
| Droid Sans Fallback | Apache-2.0 in embedded metadata | Preserve applicable notices and license text. |
| DejaVu Sans | Embedded Bitstream Vera/Arev terms; DejaVu changes public domain | Preserve the actual font terms and applicable naming conditions. |
| 35 RocketStock LUTs | 2017 RocketStock copyright notices | No redistribution grant found in this checkout; establish applicable permissions. |
| Other presets, textures, sample image, and Pantone-named palette | No clear local provenance/license inventory found | Document the sources and applicable permissions. Names alone do not establish ownership or restrictions. |

LGPL libraries do not automatically require the application's own code to use
GPL. [LGPLv3 section 4](https://opensource.org/license/lgpl-3-0) permits chosen
terms for a combined work when its conditions are satisfied. Likewise, keeping
the separate Lensfun database under its license does not necessarily impose that
license on the application. See [CC BY-SA 3.0 section 4](https://creativecommons.org/licenses/by-sa/3.0/legalcode).
The [OFL](https://openfontlicense.org/open-font-license-official-text/) permits
bundling fonts with software while retaining the fonts' terms.

**Application-code provenance needs clarification.** The
[README](../README.md#inspiration-and-prior-art) references a Photopea Offline
archive. A lexical comparison against that archive found 120 matching long
quoted-string occurrences, representing 111 distinct strings, across 28
non-vendor JavaScript files. Some matches contain substantial GLSL shader source.

The comparison used archive commit
[`6bd82e92635a9e90ee442e24502acd58cfbf67ea`](https://github.com/ruanjiyang/Photopea-Offline/tree/6bd82e92635a9e90ee442e24502acd58cfbf67ea).
The retrieved `pp.js`, `DBS.js`, and `LNG2.js` were verified against the Git blob
hashes in its recursive tree. Locations, lengths, hashes, and the method are
recorded in [licensing-evidence.json](licensing-evidence.json); the evidence file
contains no copied source text.

| Local example at the reviewed revision | Matching raw string length | Archive location |
|---|---:|---|
| [RGB/Lab shader helpers](https://github.com/eolix/photosuite/blob/768cc9f56a9accc33a0e83320e4c8cbc4696c633/src/engine/layer-system.js#L324) | 1,671 characters | [pp.js:4448](https://github.com/ruanjiyang/Photopea-Offline/blob/6bd82e92635a9e90ee442e24502acd58cfbf67ea/www.photopea.com/code/pp.js#L4448) |
| [Adjustment shader](https://github.com/eolix/photosuite/blob/768cc9f56a9accc33a0e83320e4c8cbc4696c633/src/engine/layer-system.js#L378) | 1,140 characters | [pp.js:4457](https://github.com/ruanjiyang/Photopea-Offline/blob/6bd82e92635a9e90ee442e24502acd58cfbf67ea/www.photopea.com/code/pp.js#L4457) |
| [Adjustment shader](https://github.com/eolix/photosuite/blob/768cc9f56a9accc33a0e83320e4c8cbc4696c633/src/engine/layer-system.js#L443) | 1,060 characters | [pp.js:4471](https://github.com/ruanjiyang/Photopea-Offline/blob/6bd82e92635a9e90ee442e24502acd58cfbf67ea/www.photopea.com/code/pp.js#L4471) |

These matches establish shared text, not a copying path, ownership determination,
or finding of infringement. Some material may have a separately licensed common
source. [Photopea's official repository](https://github.com/photopea/photopea)
states that the application is not fully open source; its separately licensed
MIT libraries do not establish permission for all application code. No
LICENSE/COPYING file was detected in the examined archive's recursive tree.
The maintainers may have provenance records or permissions that are not present
in this checkout.

To reproduce the screen, retrieve the two pinned revisions, enumerate `src/**/*.js`
excluding `src/vendor/`, and compare the raw contents of single/double-quoted
strings against the three archive files. The regex used was
`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`; only contents at least 70 characters long
were counted, excluding the surrounding quotes. This is a lexical screen, not a
full JavaScript parser or a measure of how much code was copied. It does not
normalize identifiers or establish legal significance. No complete non-vendor
local file matched an archive Git blob exactly.

**Additional findings for maintainer review:**

- **EXR bundle notices:** `src/vendor/js/exr/exr.js` includes fflate, but
  [the build script](../src/vendor/js/exr/build.sh) uses
  `--legal-comments=none` and copies only parse-exr's license. The license in this
  bundle directory names Damien Seguin, and fflate's separate notice was not
  found there. Recover the notice for the actual bundled version.
  [fflate upstream license](https://github.com/101arrowz/fflate/blob/master/LICENSE).
- **Fonts:** no standalone license files accompany the six files in
  `src/fonts/script/`. DejaVu embeds substantial license text; Noto and Droid
  include license references. Verify that distributions include complete
  applicable notices and license texts in an accessible form.
- **LGPL builds and installers:** FriBidi and libheif have rebuild scripts, but
  they were not executed in this review. Source/binary correspondence and a
  working replacement or recombination route remain unverified. Check the
  source for libde265 as well as libheif, application rebuild instructions,
  notices, and applicable installation information. Replacing a loose WASM file
  in a checkout does not establish that the same route works in a Tauri package.
- **LUTs and other assets:** establish permission to redistribute the actual
  files in an editor. Permission to apply a LUT to an image or video does not
  itself establish that redistribution grant. This review did not determine
  that redistribution is forbidden; the applicable grant was not found.

**Coverage:** all 16 vendor submodules were uninitialized in the reviewed
checkout. Gitlinks, local license texts, vendor documentation, and selected
upstream files were inspected without initializing them. The npm lock contains
93 dependency records with permissive license expressions: MIT, Apache-2.0,
MIT/Apache alternatives, BSD-2/3-Clause, ISC, and BlueOak-1.0.0. Most are
development tooling; package metadata is not a substitute for inspecting what
ships.

The two Cargo locks contain 604 unique registry package/version pairs. Their
licenses and native dependencies were **not exhaustively audited**. Direct
printing dependencies were spot-checked: cups_rs 0.3.0 declares MIT and winprint
0.2.1 declares BSD-3-Clause. No application build, LGPL rebuild, or installer
inspection was performed. These limits prevent treating this document as a
complete distribution clearance.

Suggested maintainer decisions are to consider Apache-2.0 versus retaining
GPLv3 as the desired licensing policy,
clarify the matching application code's sources and permissions, document asset
rights, and address the notices and distribution gaps above. If a permissive
policy is chosen and the necessary rights are established, standard Apache-2.0
with separately documented third-party licenses is a workable structure to
evaluate. The new GPLv3 license and a potential Apache-2.0 license both depend
on having the necessary permissions for the material they purport to cover.
