# HEIC fixtures

Synthetic 64 x 48 test images, generated for these tests (no photographs, no third-party image
data): a grey ramp on the left, red, green and blue bands on the right, white along the bottom.
The source PNGs were written pixel by pixel by a short script, then encoded with macOS `sips`:

| File | Source | Encoded as |
|---|---|---|
| `rgb.heic` | 8-bit RGB | `sips -s format heic` |
| `rgba.heic` | 8-bit RGBA, the 16 left columns transparent | `sips -s format heic` |
| `rgb16.heic` | 16-bit RGB | `sips -s format heic` (10-bit HEVC) |
| `icc.heic` | 8-bit RGB with PhotoSuite's own Display P3 profile (`photosuite-cms` `Builtin::DisplayP3`) embedded | `sips --embedProfile`, then `sips -s format heic` |

Licensed MIT OR Apache-2.0, like the rest of PhotoSuite.
