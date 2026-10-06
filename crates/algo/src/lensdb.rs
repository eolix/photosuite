//! Measured lens profiles (the Lensfun database, `resources/lensfun/`): matching a camera and
//! lens to a photograph, and reading the coefficients for the focal length and aperture it was
//! taken at. The pixels are [`crate::lens`]'s job; this module finds the row and interpolates.
//!
//! The database layout, the three distortion models and the two radius conventions are documented
//! in `resources/lensfun/README.md`. Measurements exist at particular focal lengths (and, for
//! vignetting, apertures and subject distances), so every lookup interpolates between the rows
//! that bracket the shot and clamps at the ends of the measured range.

use serde::{Deserialize, Serialize};

/// The profile database as stored (`lens-database.json`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LensDatabase {
    pub generated_from: String,
    pub cameras: Vec<Camera>,
    pub lenses: Vec<Lens>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Camera {
    pub maker: String,
    pub model: String,
    pub mount: String,
    pub crop_factor: f64,
    /// The literal EXIF `Make` when it isn't the brand ("Nikon Corporation").
    pub exif_maker: Option<String>,
    pub aliases: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Lens {
    pub maker: String,
    pub model: String,
    pub mount: String,
    /// Crop factor and aspect ratio of the body the lens was calibrated on.
    pub crop_factor: f64,
    pub aspect_ratio: f64,
    pub exif_maker: Option<String>,
    pub aliases: Vec<String>,
    /// `focal, model, c0, c1, c2`.
    pub distortion: Vec<[f64; 5]>,
    /// `focal, redB, redC, redV, blueB, blueC, blueV`.
    pub tca: Vec<[f64; 7]>,
    /// `focal, aperture, distance, k1, k2, k3`.
    pub vignetting: Vec<[f64; 6]>,
}

/// Distortion models, as numbered in the database.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DistortionModel {
    /// `Rd = Ru · (1 − k1 + k1·Ru²)`.
    Poly3,
    /// `Rd = Ru · (1 + k1·Ru² + k2·Ru⁴)`.
    Poly5,
    /// `Rd = Ru · (a·Ru³ + b·Ru² + c·Ru + 1 − a − b − c)`.
    PtLens,
}

/// The coefficients a photograph needs: one lens at one focal length and aperture, plus the
/// frame they were measured on (so they can be rescaled to the image's sensor).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Calibration {
    pub lens: String,
    pub distortion: Option<(DistortionModel, [f64; 3])>,
    /// Red then blue: `b, c, v` of `Rd = Ru · (b·Ru² + c·Ru + v)`.
    pub tca: Option<[[f64; 3]; 2]>,
    /// `k1, k2, k3` of the attenuation `1 + k1 r² + k2 r⁴ + k3 r⁶` (r = 1 at the corner).
    pub vignetting: Option<[f64; 3]>,
    pub calibration_crop_factor: f64,
    pub calibration_aspect_ratio: f64,
    /// The photographing body's crop factor (the calibration's when unknown).
    pub image_crop_factor: f64,
}

fn normalize(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Every name an entry answers to: its own, plus its English display names.
fn names<'a>(model: &'a str, aliases: &'a [String]) -> impl Iterator<Item = &'a str> {
    std::iter::once(model).chain(aliases.iter().map(String::as_str))
}

impl Camera {
    /// Whether a file's EXIF `Make` can belong to this body. Brands disagree about how much of the
    /// company name to write, so either containing the other is close enough; no maker recorded
    /// isn't held against it.
    fn maker_matches(&self, file_maker: &str) -> bool {
        if file_maker.is_empty() {
            return true;
        }
        let brand = normalize(&self.maker);
        let exif = normalize(self.exif_maker.as_deref().unwrap_or(&self.maker));
        file_maker.contains(&brand) || brand.contains(file_maker) || file_maker.contains(&exif) || exif.contains(file_maker)
    }
}

impl Lens {
    /// Whether the lens could have taken a shot at `focal` mm: the measurements span its range,
    /// with the rounding a body applies allowed for primes. Unknown focal lengths pass.
    pub fn covers_focal_length(&self, focal: f64) -> bool {
        if focal.is_nan() || focal <= 0.0 {
            return true;
        }
        let focals = self.distortion.iter().map(|r| r[0]).chain(self.tca.iter().map(|r| r[0])).chain(self.vignetting.iter().map(|r| r[0]));
        let (lo, hi) = focals.fold((f64::INFINITY, 0.0f64), |(lo, hi), f| (lo.min(f), hi.max(f)));
        if hi <= 0.0 {
            return true;
        }
        let tol = (lo * 0.02).max(0.5);
        focal >= lo - tol && focal <= hi + tol
    }

    /// Distortion at `focal`. Neighbours measured with different models can't be blended; the
    /// nearer one wins.
    pub fn distortion_at(&self, focal: f64) -> Option<(DistortionModel, [f64; 3])> {
        let (lo, hi) = bracket(&self.distortion, 0, focal)?;
        let k = blend(focal, lo[0], hi[0]);
        let model = |m: f64| match m as i64 {
            0 => Some(DistortionModel::Poly3),
            1 => Some(DistortionModel::Poly5),
            2 => Some(DistortionModel::PtLens),
            _ => None,
        };
        if lo[1] != hi[1] {
            let n = if k < 0.5 { lo } else { hi };
            return Some((model(n[1])?, [n[2], n[3], n[4]]));
        }
        Some((model(lo[1])?, std::array::from_fn(|i| mix(lo[i + 2], hi[i + 2], k))))
    }

    /// Lateral chromatic aberration at `focal`: red then blue `b, c, v`.
    pub fn tca_at(&self, focal: f64) -> Option<[[f64; 3]; 2]> {
        let (lo, hi) = bracket(&self.tca, 0, focal)?;
        let k = blend(focal, lo[0], hi[0]);
        let v: [f64; 6] = std::array::from_fn(|i| mix(lo[i + 1], hi[i + 1], k));
        Some([[v[0], v[1], v[2]], [v[3], v[4], v[5]]])
    }

    /// Vignetting at `focal` and `aperture`. Subject distance is rarely recorded, so the furthest
    /// measured is used; then focal length, then aperture.
    pub fn vignetting_at(&self, focal: f64, aperture: f64) -> Option<[f64; 3]> {
        let far = self.vignetting.iter().map(|r| r[2]).fold(f64::NEG_INFINITY, f64::max);
        let rows: Vec<[f64; 6]> = self.vignetting.iter().filter(|r| r[2] == far).copied().collect();
        let (flo, fhi) = bracket(&rows, 0, focal)?;
        let k = blend(focal, flo[0], fhi[0]);
        let at = |f: f64| -> Option<[f64; 3]> {
            let set: Vec<[f64; 6]> = rows.iter().filter(|r| r[0] == f).copied().collect();
            let (lo, hi) = bracket(&set, 1, aperture)?;
            let t = blend(aperture, lo[1], hi[1]);
            Some(std::array::from_fn(|i| mix(lo[i + 3], hi[i + 3], t)))
        };
        let (a, b) = (at(flo[0])?, at(fhi[0])?);
        Some(std::array::from_fn(|i| mix(a[i], b[i], k)))
    }

    /// The name to show: the model, with the brand in front when the model doesn't start with it.
    pub fn display_name(&self) -> String {
        if self.maker.is_empty() || normalize(&self.model).starts_with(&normalize(&self.maker)) {
            self.model.clone()
        } else {
            format!("{} {}", self.maker, self.model)
        }
    }

    /// The coefficients for a shot at `focal` mm and f/`aperture` on a body of `camera_crop`.
    pub fn calibration(&self, focal: f64, aperture: f64, camera_crop: Option<f64>) -> Calibration {
        let crop = if self.crop_factor > 0.0 { self.crop_factor } else { 1.0 };
        Calibration {
            lens: self.display_name(),
            distortion: self.distortion_at(focal),
            tca: self.tca_at(focal),
            vignetting: self.vignetting_at(focal, aperture),
            calibration_crop_factor: crop,
            calibration_aspect_ratio: if self.aspect_ratio > 0.0 { self.aspect_ratio } else { 1.5 },
            image_crop_factor: camera_crop.filter(|c| *c > 0.0).unwrap_or(crop),
        }
    }
}

/// The rows bracketing `target` in `col`, or the nearest one at both ends outside the range.
fn bracket<const N: usize>(rows: &[[f64; N]], col: usize, target: f64) -> Option<([f64; N], [f64; N])> {
    let mut below: Option<[f64; N]> = None;
    let mut above: Option<[f64; N]> = None;
    for r in rows {
        let v = *r.get(col)?;
        if v <= target && below.is_none_or(|b| v > b[col]) {
            below = Some(*r);
        }
        if v >= target && above.is_none_or(|a| v < a[col]) {
            above = Some(*r);
        }
    }
    match (below, above) {
        (Some(b), Some(a)) => Some((b, a)),
        (Some(x), None) | (None, Some(x)) => Some((x, x)),
        // `target` NaN: the first row.
        (None, None) => rows.first().map(|r| (*r, *r)),
    }
}

fn blend(v: f64, lo: f64, hi: f64) -> f64 {
    if hi > lo { ((v - lo) / (hi - lo)).clamp(0.0, 1.0) } else { 0.0 }
}

fn mix(a: f64, b: f64, k: f64) -> f64 {
    a + (b - a) * k
}

impl LensDatabase {
    /// The body a file was taken with, from its EXIF make and model. Bodies write the maker into
    /// the model inconsistently ("Canon EOS 5D" against "EOS 5D"), so a maker-qualified form is
    /// tried too.
    pub fn match_camera(&self, maker: Option<&str>, model: Option<&str>) -> Option<&Camera> {
        let model = normalize(model?);
        if model.is_empty() {
            return None;
        }
        let maker = normalize(maker.unwrap_or(""));
        let qualified = if !maker.is_empty() && !model.starts_with(&maker) { format!("{maker} {model}") } else { model.clone() };
        self.cameras.iter().filter(|c| c.maker_matches(&maker)).find(|c| names(&c.model, &c.aliases).map(normalize).any(|n| n == model || n == qualified))
    }

    /// Lenses that fit `camera` (all of them without one), sorted by name.
    pub fn lenses_for(&self, camera: Option<&Camera>) -> Vec<&Lens> {
        let mut v: Vec<&Lens> = self.lenses.iter().filter(|l| camera.is_none_or(|c| l.mount == c.mount)).collect();
        v.sort_by_key(|l| normalize(&format!("{} {}", l.maker, l.model)));
        v
    }

    /// The lens a file was taken with. Candidates are restricted to the body's mount first, so a
    /// generic name ("fixed lens") can only resolve to the lens that body has. A file that names a
    /// lens nothing matches gets no profile: guessing would correct with the wrong glass.
    pub fn match_lens(&self, lens: Option<&str>, camera: Option<&Camera>) -> Option<&Lens> {
        let candidates = self.lenses_for(camera);
        let wanted = normalize(lens.unwrap_or(""));
        if !wanted.is_empty() {
            if let Some(l) = candidates.iter().find(|l| names(&l.model, &l.aliases).any(|n| normalize(n) == wanted)) {
                return Some(l);
            }
            // Bodies pad lens names with mount or maker prefixes: containment, within the mount.
            return candidates
                .iter()
                .find(|l| {
                    let n = normalize(&l.model);
                    !n.is_empty() && (wanted.contains(&n) || n.contains(&wanted))
                })
                .copied();
        }
        (camera.is_some() && candidates.len() == 1).then(|| candidates[0])
    }

    /// The calibration for a photograph, from its EXIF.
    pub fn for_photo(&self, info: &crate::exif::CameraInfo) -> Option<Calibration> {
        let camera = self.match_camera(info.make.as_deref(), info.model.as_deref());
        let lens = self.match_lens(info.lens.as_deref(), camera)?;
        let focal = info.focal_length.unwrap_or(0.0);
        if !lens.covers_focal_length(focal) {
            return None;
        }
        Some(lens.calibration(focal, info.f_number.unwrap_or(8.0), camera.map(|c| c.crop_factor)))
    }

    /// A lens by its full name (`maker model`) or model.
    pub fn find_lens(&self, name: &str) -> Option<&Lens> {
        let n = normalize(name);
        self.lenses.iter().find(|l| normalize(&l.model) == n || normalize(&format!("{} {}", l.maker, l.model)) == n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> LensDatabase {
        let cam = |maker: &str, model: &str, mount: &str, crop: f64, exif: Option<&str>| Camera {
            maker: maker.into(),
            model: model.into(),
            mount: mount.into(),
            crop_factor: crop,
            exif_maker: exif.map(str::to_string),
            aliases: Vec::new(),
        };
        LensDatabase {
            generated_from: "test".into(),
            cameras: vec![cam("Nikon", "Nikon D750", "Nikon F AF", 1.0, Some("Nikon Corporation")), cam("Canon", "Canon EOS 5D", "Canon EF", 1.0, None)],
            lenses: vec![
                Lens {
                    maker: "Nikon".into(),
                    model: "AF-S Nikkor 24-70mm f/2.8G ED".into(),
                    mount: "Nikon F AF".into(),
                    crop_factor: 1.0,
                    aspect_ratio: 1.5,
                    distortion: vec![[24.0, 2.0, 0.01, -0.03, 0.0], [70.0, 2.0, 0.0, 0.01, 0.0]],
                    tca: vec![[24.0, 0.0, 0.0, 1.0002, 0.0, 0.0, 0.9998]],
                    vignetting: vec![[24.0, 2.8, 1000.0, -0.6, 0.2, 0.0], [24.0, 8.0, 1000.0, -0.2, 0.0, 0.0], [70.0, 2.8, 1000.0, -0.3, 0.0, 0.0], [70.0, 8.0, 1000.0, -0.1, 0.0, 0.0]],
                    ..Default::default()
                },
                Lens { maker: "Canon".into(), model: "EF 50mm f/1.8 II".into(), mount: "Canon EF".into(), crop_factor: 1.0, distortion: vec![[50.0, 0.0, -0.005, 0.0, 0.0]], ..Default::default() },
            ],
        }
    }

    #[test]
    fn matches_bodies_and_lenses_the_way_files_name_them() {
        let d = db();
        // The corporate EXIF maker; a model written without the brand.
        let c = d.match_camera(Some("NIKON CORPORATION"), Some("NIKON D750")).expect("corporate maker");
        assert_eq!(c.model, "Nikon D750");
        assert!(d.match_camera(Some("Canon"), Some("EOS 5D")).is_some());
        assert!(d.match_camera(Some("Canon"), Some("D750")).is_none(), "the maker must agree");
        // Padded lens names match within the mount; a named lens nothing matches gets nothing.
        assert!(d.match_lens(Some("Nikon AF-S Nikkor 24-70mm f/2.8G ED"), Some(c)).is_some());
        assert!(d.match_lens(Some("EF 50mm f/1.8 II"), Some(c)).is_none(), "wrong mount");
        assert!(d.match_lens(Some("Sigma 35mm"), Some(c)).is_none());
    }

    #[test]
    fn interpolates_between_measurements_and_clamps_outside() {
        let d = db();
        let l = &d.lenses[0];
        let (m, k) = l.distortion_at(47.0).unwrap();
        assert_eq!(m, DistortionModel::PtLens);
        assert!((k[0] - 0.005).abs() < 1e-9 && (k[1] + 0.01).abs() < 1e-9, "{k:?}");
        assert_eq!(l.distortion_at(10.0).unwrap().1, [0.01, -0.03, 0.0], "clamped below");
        let v = l.vignetting_at(24.0, 5.4).unwrap();
        assert!((v[0] + 0.4).abs() < 1e-9, "{v:?}");
        let v = l.vignetting_at(47.0, 2.8).unwrap();
        assert!((v[0] + 0.45).abs() < 1e-9, "{v:?}");
        assert!(l.covers_focal_length(70.0) && !l.covers_focal_length(105.0));
        let info = crate::exif::CameraInfo {
            make: Some("NIKON CORPORATION".into()),
            model: Some("NIKON D750".into()),
            lens: Some("24-70mm f/2.8G".into()),
            focal_length: Some(35.0),
            f_number: Some(4.0),
            ..Default::default()
        };
        let cal = d.for_photo(&info).expect("profile for the shot");
        assert!(cal.lens.contains("24-70"));
        assert!(cal.tca.is_some() && cal.vignetting.is_some());
        assert!(d.for_photo(&crate::exif::CameraInfo { focal_length: Some(200.0), ..info }).is_none(), "outside the lens's range");
    }
}
