# FriBidi (WASM)

`fribidi.wasm` — a WebAssembly build of [GNU FriBidi](https://github.com/fribidi/fribidi),
the Unicode Bidirectional Algorithm (UAX #9) implementation. Used to resolve
embedding levels for right-to-left / mixed-direction text before shaping.

| | |
|---|---|
| **Upstream** | [fribidi/fribidi](https://github.com/fribidi/fribidi) — pinned submodule at `src/vendor/fribidi` @ `v1.0.16` |
| **License** | **LGPL-2.1-or-later** (see `LICENSE`) |
| **Exports** | `fribidi_get_bidi_types`, `fribidi_get_bracket_types`, `fribidi_get_par_embedding_levels_ex`, `fribidi_utf8_to_unicode` |
| **Loaded by** | `src/layers/layer-channel-canvas-adjust.js` (`fetch("vendor/wasm/fribidi/fribidi.wasm")`) |

## License notice (LGPL-2.1+)

This product includes FriBidi, which is licensed under the GNU Lesser General
Public License, version 2.1 or later. The full license text is in `LICENSE`.

LGPL compliance for this statically-linked WebAssembly module is satisfied by
providing the **corresponding source** and the **means to relink**:

- The corresponding source is the pinned submodule at `src/vendor/fribidi`
  (`v1.0.16`, unmodified upstream).
- `build.sh` regenerates `fribidi.wasm` from that source (or from a modified
  copy of it), documenting the toolchain — this is the relink path.

## Reproduction

```sh
./build.sh        # needs emscripten (emcc) + meson/ninja on PATH
```

The checked-in `fribidi.wasm` is a prebuilt binary; the canonical reproduction
is `build.sh`. To guarantee byte-for-byte source↔binary correspondence (and the
cleanest LGPL posture), run `build.sh` and let its output replace the prebuilt
binary.
