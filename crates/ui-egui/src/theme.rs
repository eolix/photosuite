//! Design system: themes, colour tokens, radii, typography.
//!
//! - **Studio** (default): near-black surfaces, rounded cards, Inter + JetBrains Mono, soft violet
//!   accent. Modelled on the look of modern pro editors (such as Photoshop 2025).
//! - **Studio Light**: the same system on light surfaces.
//! - **Classic**: a deliberately Windows-2000-era look (grey bevels, square corners, navy selection)
//!   for people who prefer it.
//!
//! Widgets read [`Tokens::get`] instead of hard-coding colours, so every theme applies everywhere.

use egui::{Color32, CornerRadius, FontData, FontDefinitions, FontFamily, FontId, Stroke, TextStyle, Visuals};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// The themes PhotoSuite ships. Each declares four base colours and a few surfaces; every other
/// token is derived from them in [`Tokens::for_kind`], so a palette stays internally consistent
/// and a new one needs only the bases.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ThemeKind {
    Midnight,
    Anthracite,
    #[default]
    Slate,
    Pearl,
    Aubergine,
    Ocean,
}

/// A palette's declared colours, before derivation.
#[derive(Clone, Copy)]
struct Bases {
    /// Window chrome: title bar, option bars.
    chrome: u32,
    /// Panels and cards.
    panel: u32,
    /// The surround the document sits on.
    canvas: u32,
    /// Inputs and fields.
    input: u32,
    /// Buttons hovered. There is no separate resting button fill: buttons draw on the card and
    /// field surfaces.
    button_hover: u32,
    /// Structural border.
    border: u32,
    text: u32,
    accent: u32,
}

impl ThemeKind {
    pub const ALL: [ThemeKind; 6] =
        [ThemeKind::Midnight, ThemeKind::Anthracite, ThemeKind::Slate, ThemeKind::Pearl, ThemeKind::Aubergine, ThemeKind::Ocean];

    pub fn label(self) -> &'static str {
        match self {
            ThemeKind::Midnight => "Midnight",
            ThemeKind::Anthracite => "Anthracite",
            ThemeKind::Slate => "Slate",
            ThemeKind::Pearl => "Pearl",
            ThemeKind::Aubergine => "Aubergine",
            ThemeKind::Ocean => "Ocean",
        }
    }

    pub fn next(self) -> Self {
        let i = Self::ALL.iter().position(|k| *k == self).unwrap_or(0);
        Self::ALL[(i + 1) % Self::ALL.len()]
    }

    pub fn from_name(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().replace([' ', '_', '-', '(', ')'], "").as_str() {
            "midnight" | "dark" => Some(ThemeKind::Midnight),
            "anthracite" | "gray" | "grey" => Some(ThemeKind::Anthracite),
            "slate" => Some(ThemeKind::Slate),
            "pearl" | "light" => Some(ThemeKind::Pearl),
            "aubergine" | "purple" => Some(ThemeKind::Aubergine),
            "ocean" | "blue" => Some(ThemeKind::Ocean),
            _ => None,
        }
    }

    fn bases(self) -> Bases {
        match self {
            ThemeKind::Midnight => Bases {
                chrome: 0x1E2127,
                panel: 0x191C22,
                canvas: 0x14171D,
                input: 0x252930,
                button_hover: 0x343A47,
                border: 0x222630,
                text: 0xD4DAE5,
                accent: 0x3794FF,
            },
            ThemeKind::Anthracite => Bases {
                chrome: 0x383838,
                panel: 0x2E2E2E,
                canvas: 0x202020,
                input: 0x262626,
                button_hover: 0x525252,
                border: 0x242424,
                text: 0xDCDCDC,
                accent: 0x4A90E2,
            },
            ThemeKind::Slate => Bases {
                chrome: 0x363D4D,
                panel: 0x2B3242,
                canvas: 0x1E2534,
                input: 0x232A38,
                button_hover: 0x4B5568,
                border: 0x222939,
                text: 0xE4E9F2,
                accent: 0x5B8DEF,
            },
            ThemeKind::Pearl => Bases {
                chrome: 0xF2F2F7,
                panel: 0xE9E9EE,
                canvas: 0xCBCBD2,
                input: 0xFFFFFF,
                button_hover: 0xECECF1,
                border: 0xD2D2D8,
                text: 0x1C1C1E,
                accent: 0x007AFF,
            },
            ThemeKind::Aubergine => Bases {
                chrome: 0x40334A,
                panel: 0x322539,
                canvas: 0x261C30,
                input: 0x2F2338,
                button_hover: 0x5E4A6B,
                border: 0x241A2C,
                text: 0xEDE6F3,
                accent: 0xB065E6,
            },
            ThemeKind::Ocean => Bases {
                chrome: 0x16253F,
                panel: 0x101E34,
                canvas: 0x0C1525,
                input: 0x16253F,
                button_hover: 0x2C476F,
                border: 0x0F1B2E,
                text: 0xD5E3F5,
                accent: 0x0EA5E9,
            },
        }
    }
}

fn rgb(v: u32) -> Color32 {
    Color32::from_rgb((v >> 16) as u8, (v >> 8) as u8, v as u8)
}

/// Blend `amount` of `to` into `from`, per channel.
fn mix(from: u32, to: u32, amount: f32) -> Color32 {
    let ch = |shift: u32| {
        let (a, b) = (((from >> shift) & 255) as f32, ((to >> shift) & 255) as f32);
        (a + (b - a) * amount).round() as u8
    };
    Color32::from_rgb(ch(16), ch(8), ch(0))
}

/// Perceived brightness on 0..1, used to pick readable text over a fill.
fn luminance(v: u32) -> f32 {
    (0.2126 * ((v >> 16) & 255) as f32 + 0.7152 * ((v >> 8) & 255) as f32 + 0.0722 * (v & 255) as f32) / 255.0
}

/// Colour and shape tokens.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tokens {
    pub kind: ThemeKind,
    /// Window chrome (title bar, toolbars).
    pub chrome: Color32,
    /// Canvas surround.
    pub canvas: Color32,
    /// Dot colour of the canvas grid pattern.
    pub canvas_dot: Color32,
    /// Dock background (behind cards).
    pub dock: Color32,
    /// Cards / panels.
    pub card: Color32,
    pub card_border: Color32,
    /// Inputs, fields, dropdowns.
    pub field: Color32,
    pub field_border: Color32,
    pub hover: Color32,
    pub pressed: Color32,
    pub text: Color32,
    pub text_dim: Color32,
    pub text_faint: Color32,
    pub icon: Color32,
    pub accent: Color32,
    pub accent_soft: Color32,
    pub accent_border: Color32,
    pub accent_text: Color32,
    pub separator: Color32,
    pub shadow: Color32,
    pub primary_bg: Color32,
    pub primary_text: Color32,
    pub danger: Color32,
    pub warning: Color32,
    pub radius_sm: f32,
    pub radius: f32,
    pub radius_lg: f32,
    /// Classic theme draws 3D bevels instead of flat fills.
    pub bevel: bool,
    /// Pro (Photoshop-grammar) layout: tab strips, flat panels, checkboxes, pill buttons.
    pub pro: bool,
    /// Panel tab-strip background (Pro).
    pub tab_strip: Color32,
    /// Selected list row (layers, history).
    pub row_selected: Color32,
}

impl Tokens {
    /// Derive every token from the palette's bases, the way PhotoSuite does: hover and active
    /// fills mix toward the text colour so they lift on dark palettes and deepen on light ones,
    /// and muted text mixes back toward the panel.
    pub fn for_kind(kind: ThemeKind) -> Self {
        let b = kind.bases();
        let on_accent = if luminance(b.accent) > 0.62 { rgb(0x101216) } else { Color32::WHITE };
        Tokens {
            kind,
            chrome: rgb(b.chrome),
            canvas: rgb(b.canvas),
            canvas_dot: mix(b.canvas, b.text, 0.06),
            dock: rgb(b.panel),
            card: rgb(b.panel),
            card_border: rgb(b.border),
            field: rgb(b.input),
            field_border: mix(b.input, b.text, 0.24),
            hover: rgb(b.button_hover),
            pressed: mix(b.button_hover, b.text, 0.10),
            text: rgb(b.text),
            text_dim: mix(b.text, b.panel, 0.40),
            text_faint: mix(b.text, b.panel, 0.62),
            icon: rgb(b.text),
            accent: rgb(b.accent),
            accent_soft: mix(b.panel, b.accent, 0.30),
            accent_border: rgb(b.accent),
            accent_text: on_accent,
            separator: mix(b.panel, b.text, 0.13),
            shadow: Color32::from_black_alpha(90),
            primary_bg: rgb(b.accent),
            primary_text: on_accent,
            danger: rgb(0xE5484D),
            warning: rgb(0xE2A03F),
            // Small, medium and large corner radii.
            radius_sm: 3.0,
            radius: 5.0,
            radius_lg: 7.0,
            // PhotoSuite is Photoshop-shaped too, so it keeps the tab-strip grammar: panel tab
            // strips, flat panels, pill buttons. Only the palette changes.
            bevel: false,
            pro: true,
            tab_strip: mix(b.panel, 0x000000, 0.18),
            row_selected: mix(b.panel, b.text, 0.16),
        }
    }


    pub fn get(ctx: &egui::Context) -> Tokens {
        ctx.data(|d| d.get_temp::<Tokens>(egui::Id::new("photosuite-theme"))).unwrap_or_else(|| Tokens::for_kind(ThemeKind::default()))
    }

    /// Is this a dark palette? Measured from the chrome rather than listed, so a new palette
    /// answers correctly without being added here.
    pub fn dark(&self) -> bool {
        luminance(
            ((self.chrome.r() as u32) << 16) | ((self.chrome.g() as u32) << 8) | self.chrome.b() as u32,
        ) < 0.5
    }
}

/// Register Inter (UI) and JetBrains Mono (numbers) plus named weights.
pub fn install_fonts(ctx: &egui::Context) {
    set_fonts(ctx, 1.0);
    // Japanese / Chinese / Korean system fonts are registered on demand (cjk_fonts.rs).
    crate::cjk_fonts::install(ctx);
}

/// Preferences › Interface › UI Font Size: every glyph drawn `scale` times its nominal size
/// (egui's per-font tweak), so all text grows, including sizes set directly in code, while
/// the rest of the interface and the canvas keep their size, as in Photoshop.
pub fn set_font_scale(ctx: &egui::Context, scale: f32) {
    let key = egui::Id::new("ui-font-scale");
    let cur = ctx.data(|d| d.get_temp::<f32>(key)).unwrap_or(1.0);
    if (cur - scale).abs() > 1e-3 {
        set_fonts(ctx, scale);
        ctx.data_mut(|d| d.insert_temp(key, scale));
    }
}

fn set_fonts(ctx: &egui::Context, scale: f32) {
    let mut fonts = FontDefinitions::default();
    let tweak = egui::FontTweak { scale, ..Default::default() };
    for f in fonts.font_data.values_mut() {
        Arc::make_mut(f).tweak.scale = scale;
    }
    let add = |fonts: &mut FontDefinitions, name: &str, bytes: &'static [u8]| {
        fonts.font_data.insert(name.to_owned(), Arc::new(FontData::from_static(bytes).tweak(tweak.clone())));
    };
    add(&mut fonts, "Inter", photosuite_text::fonts::INTER_REGULAR);
    add(&mut fonts, "Inter-Medium", photosuite_text::fonts::INTER_MEDIUM);
    add(&mut fonts, "Inter-SemiBold", photosuite_text::fonts::INTER_SEMIBOLD);
    add(&mut fonts, "JetBrainsMono", photosuite_text::fonts::JETBRAINS_MONO_REGULAR);
    fonts.families.entry(FontFamily::Proportional).or_default().insert(0, "Inter".to_owned());
    fonts.families.entry(FontFamily::Monospace).or_default().insert(0, "JetBrainsMono".to_owned());
    // Named weights fall back to the default stack for missing glyphs.
    let fallback: Vec<String> = fonts.families[&FontFamily::Proportional].clone();
    for (fam, primary) in [("medium", "Inter-Medium"), ("semibold", "Inter-SemiBold")] {
        let mut stack = vec![primary.to_owned()];
        stack.extend(fallback.iter().cloned());
        fonts.families.insert(FontFamily::Name(fam.into()), stack);
    }
    ctx.set_fonts(fonts);
}

pub fn medium(size: f32) -> FontId {
    FontId::new(size, FontFamily::Name("medium".into()))
}
pub fn semibold(size: f32) -> FontId {
    FontId::new(size, FontFamily::Name("semibold".into()))
}
pub fn mono(size: f32) -> FontId {
    FontId::monospace(size)
}

/// Apply a theme to egui's global style and publish its tokens.
pub fn apply(ctx: &egui::Context, kind: ThemeKind) {
    let t = Tokens::for_kind(kind);
    ctx.data_mut(|d| d.insert_temp(egui::Id::new("photosuite-theme"), t));
    // The system title bar follows: dark under the dark themes on Windows, and the Adwaita frame
    // winit draws on GNOME's Wayland. Not on macOS, where the title bar is the app's own and an
    // app-wide appearance would also restyle the native menus and file dialogs.
    if !cfg!(target_os = "macos") {
        let theme = if t.dark() { egui::SystemTheme::Dark } else { egui::SystemTheme::Light };
        ctx.send_viewport_cmd(egui::ViewportCommand::SetTheme(theme));
    }
    let mut v = if t.dark() { Visuals::dark() } else { Visuals::light() };
    v.panel_fill = t.chrome;
    v.window_fill = t.card;
    v.window_stroke = Stroke::new(1.0, t.card_border);
    v.extreme_bg_color = t.field;
    v.faint_bg_color = t.card;
    v.code_bg_color = t.field;
    v.override_text_color = Some(t.text);
    v.hyperlink_color = t.accent;
    v.warn_fg_color = t.warning;
    v.error_fg_color = t.danger;
    v.window_corner_radius = CornerRadius::same(t.radius_lg as u8);
    v.menu_corner_radius = CornerRadius::same(t.radius as u8);
    v.window_shadow = egui::Shadow { offset: [0, 10], blur: 32, spread: 0, color: t.shadow };
    v.popup_shadow = egui::Shadow { offset: [0, 6], blur: 20, spread: 0, color: t.shadow };
    v.selection.bg_fill = if t.bevel || t.pro { t.accent } else { t.accent_soft };
    v.selection.stroke = Stroke::new(1.0, t.accent_text);
    v.slider_trailing_fill = true;
    v.handle_shape = egui::style::HandleShape::Circle;
    v.striped = false;
    let r = CornerRadius::same(t.radius_sm as u8);
    let w = &mut v.widgets;
    w.noninteractive.bg_fill = t.card;
    w.noninteractive.weak_bg_fill = t.card;
    w.noninteractive.bg_stroke = Stroke::new(1.0, t.separator);
    w.noninteractive.fg_stroke = Stroke::new(1.0, t.text_dim);
    w.noninteractive.corner_radius = r;
    for (wv, bg, stroke) in [
        (&mut w.inactive, t.field, t.field_border),
        (&mut w.hovered, t.hover, t.field_border),
        (&mut w.active, t.pressed, t.accent_border),
        (&mut w.open, t.hover, t.field_border),
    ] {
        wv.bg_fill = bg;
        wv.weak_bg_fill = bg;
        wv.bg_stroke = if t.bevel { Stroke::new(1.0, Color32::from_gray(64)) } else { Stroke::new(1.0, stroke) };
        wv.fg_stroke = Stroke::new(1.0, t.text);
        wv.corner_radius = r;
        wv.expansion = 0.0;
    }
    ctx.set_visuals(v);
    ctx.global_style_mut(|s| {
        s.text_styles = [
            (TextStyle::Small, FontId::proportional(10.5)),
            (TextStyle::Body, FontId::proportional(if t.pro { 12.0 } else { 12.5 })),
            (TextStyle::Button, FontId::proportional(if t.pro { 12.0 } else { 12.5 })),
            (TextStyle::Heading, semibold(15.0)),
            (TextStyle::Monospace, FontId::monospace(12.0)),
        ]
        .into();
        s.spacing.item_spacing = egui::vec2(8.0, 6.0);
        s.spacing.button_padding = egui::vec2(10.0, 4.0);
        s.spacing.interact_size = egui::vec2(24.0, 24.0);
        s.spacing.slider_width = 150.0;
        s.spacing.combo_width = 120.0;
        s.spacing.menu_margin = egui::Margin::same(6);
        s.spacing.window_margin = egui::Margin::same(16);
        s.spacing.icon_width = 14.0;
        s.visuals.indent_has_left_vline = false;
        s.interaction.tooltip_delay = TOOLTIP_DELAY;
        // Thin overlay scrollbars that appear on hover (Photoshop/macOS style).
        s.spacing.scroll = if t.bevel { egui::style::ScrollStyle::solid() } else { egui::style::ScrollStyle::thin() };
        s.spacing.tooltip_width = 280.0;
    });
}

/// Seconds the pointer rests on a control before its tooltip shows.
pub const TOOLTIP_DELAY: f32 = 0.35;

/// Vertical gap between stacked control rows in panels (Properties fields, the Layers panel's
/// Opacity and Fill rows); docks zero egui's item spacing, so rows add this themselves.
pub const ROW_GAP: f32 = 4.0;

pub fn canvas_bg(t: &Tokens) -> Color32 {
    t.canvas
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The system title bar is told the theme's light or dark (Windows' title bar, the Adwaita
    /// frame on GNOME's Wayland); never on macOS, where the title bar is the app's own.
    #[test]
    fn applying_a_theme_sets_the_window_theme_outside_macos() {
        for (kind, want) in [(ThemeKind::Slate, egui::SystemTheme::Dark), (ThemeKind::Pearl, egui::SystemTheme::Light)] {
            let ctx = egui::Context::default();
            let mut out = ctx.run_ui(egui::RawInput::default(), |ui| apply(ui.ctx(), kind));
            out.textures_delta.clear();
            let cmds = out.viewport_output.get(&egui::ViewportId::ROOT).map(|v| v.commands.clone()).unwrap_or_default();
            let sent = cmds.iter().any(|c| *c == egui::ViewportCommand::SetTheme(want));
            assert_eq!(sent, !cfg!(target_os = "macos"), "{kind:?}: {cmds:?}");
        }
    }

    #[test]
    fn theme_names_parse() {
        assert_eq!(ThemeKind::from_name("Midnight"), Some(ThemeKind::Midnight));
        assert_eq!(ThemeKind::from_name("anthracite"), Some(ThemeKind::Anthracite));
        assert_eq!(ThemeKind::from_name("Slate"), Some(ThemeKind::Slate));
        assert_eq!(ThemeKind::from_name("pearl"), Some(ThemeKind::Pearl));
        assert_eq!(ThemeKind::from_name("Aubergine"), Some(ThemeKind::Aubergine));
        assert_eq!(ThemeKind::from_name("ocean"), Some(ThemeKind::Ocean));
        // Shorthands kept so older preferences and scripts still resolve.
        assert_eq!(ThemeKind::from_name("dark"), Some(ThemeKind::Midnight));
        assert_eq!(ThemeKind::from_name("light"), Some(ThemeKind::Pearl));
        assert_eq!(ThemeKind::from_name("neon"), None);
        let m = Tokens::for_kind(ThemeKind::Anthracite);
        assert!(m.kind == ThemeKind::Anthracite && m.card == Color32::from_rgb(0x2E, 0x2E, 0x2E));
    }

    /// Every palette has to stay readable: the derived text tokens mix toward the panel, so a
    /// palette whose bases are too close together would wash them out.
    #[test]
    fn every_palette_has_readable_text() {
        let lum = |c: Color32| 0.2126 * c.r() as f32 + 0.7152 * c.g() as f32 + 0.0722 * c.b() as f32;
        for kind in ThemeKind::ALL {
            let t = Tokens::for_kind(kind);
            let label = kind.label();
            assert!((lum(t.text) - lum(t.card)).abs() > 150.0, "{label}: text on card");
            assert!((lum(t.text_dim) - lum(t.card)).abs() > 80.0, "{label}: dim text on card");
            assert!((lum(t.text_faint) - lum(t.card)).abs() > 40.0, "{label}: faint text on card");
            // `dark()` is measured from the chrome, so it must agree with the palette.
            assert_eq!(t.dark(), kind != ThemeKind::Pearl, "{label}: dark()");
        }
    }
}

/// Development feature: live design-token overrides.
///
/// Set `PHOTOSUITE_THEME_FILE=/path/tokens.json` in a debug build; the file is polled and applied
/// on change, so colours, radii and sizes can be tuned without recompiling. Keys are `Tokens` field
/// names; values are `"#rrggbb"`, `"#rrggbbaa"` or numbers. Compiled out of release builds.
#[cfg(all(debug_assertions, not(target_arch = "wasm32")))]
pub mod live {
    use super::Tokens;
    use egui::Color32;
    use std::time::SystemTime;

    #[derive(Default)]
    pub struct LiveTokens {
        path: Option<std::path::PathBuf>,
        stamp: Option<SystemTime>,
        last_check: f64,
    }

    impl LiveTokens {
        pub fn from_env() -> Self {
            Self { path: std::env::var_os("PHOTOSUITE_THEME_FILE").map(Into::into), ..Default::default() }
        }

        /// Re-apply overrides if the file changed. Returns true when tokens were updated.
        pub fn poll(&mut self, ctx: &egui::Context, kind: super::ThemeKind) -> bool {
            let Some(path) = &self.path else { return false };
            let now = ctx.input(|i| i.time);
            if now - self.last_check < 0.4 {
                ctx.request_repaint_after(std::time::Duration::from_millis(400));
                return false;
            }
            self.last_check = now;
            ctx.request_repaint_after(std::time::Duration::from_millis(400));
            let Ok(meta) = std::fs::metadata(path) else { return false };
            let stamp = meta.modified().ok();
            if stamp == self.stamp {
                return false;
            }
            self.stamp = stamp;
            let Ok(text) = std::fs::read_to_string(path) else { return false };
            match serde_json::from_str::<serde_json::Value>(&text) {
                Ok(v) => {
                    super::apply(ctx, kind);
                    let mut t = Tokens::get(ctx);
                    let unknown = apply_overrides(&mut t, &v);
                    ctx.data_mut(|d| d.insert_temp(egui::Id::new("photosuite-theme"), t));
                    if !unknown.is_empty() {
                        log::warn!("unknown token keys: {unknown:?}");
                    }
                    true
                }
                Err(e) => {
                    log::warn!("theme file: {e}");
                    false
                }
            }
        }
    }

    fn color(v: &serde_json::Value) -> Option<Color32> {
        let s = v.as_str()?.trim_start_matches('#');
        let b = |i: usize| u8::from_str_radix(s.get(i..i + 2)?, 16).ok();
        match s.len() {
            6 => Some(Color32::from_rgb(b(0)?, b(2)?, b(4)?)),
            8 => Some(Color32::from_rgba_unmultiplied(b(0)?, b(2)?, b(4)?, b(6)?)),
            _ => None,
        }
    }

    /// Apply JSON overrides onto tokens; returns unknown keys.
    pub fn apply_overrides(t: &mut Tokens, v: &serde_json::Value) -> Vec<String> {
        let mut unknown = Vec::new();
        let Some(obj) = v.as_object() else { return unknown };
        for (k, val) in obj {
            macro_rules! c {
                ($($f:ident),*) => {
                    match k.as_str() {
                        $(stringify!($f) => { if let Some(c) = color(val) { t.$f = c; } })*
                        "radius_sm" => { if let Some(x) = val.as_f64() { t.radius_sm = x as f32; } }
                        "radius" => { if let Some(x) = val.as_f64() { t.radius = x as f32; } }
                        "radius_lg" => { if let Some(x) = val.as_f64() { t.radius_lg = x as f32; } }
                        _ => unknown.push(k.clone()),
                    }
                };
            }
            c!(
                chrome,
                canvas,
                canvas_dot,
                dock,
                card,
                card_border,
                field,
                field_border,
                hover,
                pressed,
                text,
                text_dim,
                text_faint,
                icon,
                accent,
                accent_soft,
                accent_border,
                accent_text,
                separator,
                shadow,
                primary_bg,
                primary_text,
                danger,
                warning,
                tab_strip,
                row_selected
            );
        }
        unknown
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn overrides_apply_and_report_unknown() {
            let mut t = Tokens::for_kind(super::super::ThemeKind::Midnight);
            let unknown = apply_overrides(&mut t, &serde_json::json!({"card": "#102030", "radius": 9, "nope": 1}));
            assert_eq!(t.card, Color32::from_rgb(16, 32, 48));
            assert_eq!(t.radius, 9.0);
            assert_eq!(unknown, vec!["nope".to_string()]);
        }
    }
}
