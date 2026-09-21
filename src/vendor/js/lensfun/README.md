# Lens correction profiles (Lensfun database)

`lens-database.json` is generated from the [Lensfun](https://github.com/lensfun/lensfun)
submodule at `src/vendor/lensfun` by `build.sh`. It holds the per-lens
measurements Lens Correction's Auto tab needs: geometric distortion, transverse
chromatic aberration, and vignetting, indexed by camera and lens.

Only the **database** is used. Lensfun's library is C under LGPL3, and what it
does with these numbers is evaluate polynomials — the app already has the warp
map, the per-channel radial scale, and the radial falloff those polynomials
drive, so there is nothing to link and nothing to compile.

## Licence

The Lensfun database is **CC BY-SA 3.0** (`LICENSE`, copied from the
submodule's `data/COPYING.CC_BY-SA_3.0`). `lens-database.json` is an adaptation
of it and carries the same licence and attribution. The app's own source is a
separate work and is unaffected.

## Contents

1051 cameras and 1561 calibrated lenses, 2.4 MB across 58k lines (0.44 MB
gzipped). The file is formatted to be read: one camera per line, one lens per
block, one calibration measurement per line, and a `columns` map at the top so
the tables describe themselves without reference to this document.

```
cameras   { maker, model, mount, cropFactor, exifMaker?, aliases? }
lenses    { maker, model, mount, cropFactor, aspectRatio, exifMaker?, aliases?,
            distortion?, tca?, vignetting? }
```

`maker` is the brand — what a person calls it, and what the app lists. Where a
camera writes something else into EXIF `Make`, that literal string is kept as
`exifMaker`, because it is what identifies the body in a file: Nikon's SLRs
write "Nikon Corporation" where its compacts write "Nikon", and Olympus manages
four variants. `aliases` are English display names for the model, useful as
secondary match candidates; other translations are dropped, since they cannot
appear in a file's metadata.

The calibration tables are arrays with a fixed column order:

| table | columns |
|---|---|
| `distortion` | `focal, model, c0, c1, c2` |
| `tca` | `focal, redB, redC, redV, blueB, blueC, blueV` |
| `vignetting` | `focal, aperture, distance, k1, k2, k3` |

Entries are measured at particular focal lengths (and apertures and subject
distances, for vignetting); a reader interpolates between the neighbouring rows
for the values a photograph was actually taken at.

## Models

Verified against `libs/lensfun/mod-coord.cpp`, `mod-subpix.cpp` and
`mod-color.cpp` in the submodule rather than assumed — the two coordinate
systems below are easy to get wrong, and getting them wrong yields corrections
that look plausible and are not.

### Coordinate systems

- **Distortion and TCA** use the Hugin convention: `r = 1` at the middle of the
  long edge, which is half the image height in landscape.
- **Vignetting** uses `r = 1` at the image **corner**.

### Geometric distortion

`Ru` is the undistorted radius, `Rd` the distorted one; a warp map samples the
source at `Rd` for each output position at `Ru`.

| `model` | formula |
|---|---|
| `0` poly3 | `Rd = Ru · (1 − k1 + k1·Ru²)` &nbsp; *(c0 = k1)* |
| `1` poly5 | `Rd = Ru · (1 + k1·Ru² + k2·Ru⁴)` &nbsp; *(c0 = k1, c1 = k2)* |
| `2` ptlens | `Rd = Ru · (a·Ru³ + b·Ru² + c·Ru + d)`, `d = 1 − a − b − c` &nbsp; *(c0 = a, c1 = b, c2 = c)* |

poly3 and ptlens are normalised so that `Ru = 1` maps to `Rd = 1`, holding the
middle of the long edge fixed. poly5 is not.

### Transverse chromatic aberration

Per channel, against green: `Rd = Ru · (b·Ru² + c·Ru + v)`. Lensfun's `linear`
model is the same expression with `b = c = 0`, so the converter folds it into
these columns with `v = kr` / `v = kb`.

### Vignetting

`c = 1 + k1·r² + k2·r⁴ + k3·r⁶` is the attenuation the lens applies, so
**correcting divides by `c`**. `k1` is normally negative, which darkens the
corners as expected when the model is used to simulate rather than remove.

### Calibrations shot on a different body

Coefficients are stored for the crop factor and aspect ratio in the lens entry.
Applying them to an image whose sensor differs needs the coefficients rescaled;
Lensfun does this in `rescale_polynomial_coefficients` in each of the three
source files above.
