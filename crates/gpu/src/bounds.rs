//! Layer bounds exactly as `photosuite-compose` computes them (`layer_bounds`), with the per-tile
//! content scan cached by copy-on-write tile identity, so an effect layer's region costs a hash
//! lookup per tile instead of a pixel scan per frame.

use photosuite_doc::Layer;
use photosuite_geom::Rect;
#[cfg(test)]
use photosuite_raster::Surface;

pub use photosuite_compose::bounds::content_bounds;

/// Bounds of a layer's own pixels: `photosuite_compose::layer_bounds`.
pub fn layer_bounds(layer: &Layer, canvas: Rect) -> Rect {
    photosuite_compose::layer_bounds(layer, canvas)
}

/// The region a layer's effect maps cover: its bounds grown by the effect reach, within the
/// canvas grown likewise (`photosuite_compose::effect_maps`).
pub fn effect_region(layer: &Layer, canvas: Rect) -> Rect {
    let m = photosuite_compose::effects::margin(layer);
    layer_bounds(layer, canvas).inflate(m).intersect(&canvas.inflate(m))
}

/// `photosuite_compose::transparent_outside`.
pub fn transparent_outside(layer: &Layer) -> bool {
    photosuite_compose::transparent_outside(layer)
}

/// `photosuite_compose::composite_bounds`: where compositing the layer can change anything.
pub fn composite_bounds(layer: &Layer, canvas: Rect) -> Option<Rect> {
    photosuite_compose::composite_bounds(layer, canvas)
}

#[cfg(test)]
mod tests {
    use super::*;
    use photosuite_color::PixelFormat;

    #[test]
    fn matches_surface_content_bounds() {
        let mut s = Surface::new(PixelFormat::RGBA8);
        assert_eq!(content_bounds(&s), s.content_bounds());
        s.fill_rect(Rect::new(10, 300, 40, 700), &[1.0, 0.0, 0.0, 1.0]);
        s.fill_rect(Rect::new(-50, 5, -3, 9), &[0.0, 0.0, 1.0, 0.5]);
        assert_eq!(content_bounds(&s), s.content_bounds());
        // Cached a second time, and after a change.
        assert_eq!(content_bounds(&s), s.content_bounds());
        s.fill_rect(Rect::new(600, 600, 601, 601), &[0.0, 1.0, 0.0, 1.0]);
        assert_eq!(content_bounds(&s), s.content_bounds());
        let mut g = Surface::with_default(PixelFormat::GRAY8, &[1.0]);
        g.fill_rect(Rect::new(3, 3, 9, 9), &[0.5]);
        assert_eq!(content_bounds(&g), g.content_bounds());
    }
}
