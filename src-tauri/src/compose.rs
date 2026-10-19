//! Crop a selection out of a full-resolution frame and merge the annotation layer.
//!
//! All geometry entering this module is in **logical points** (CSS px); the
//! single conversion to physical pixels happens in [`to_pixel_rect`]. Keeping it
//! in one place is what makes 1x/2x mixed setups behave.

use crate::types::Rect;
use anyhow::{anyhow, Result};
use image::{imageops, RgbaImage};

/// A rectangle in physical pixels of the captured frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// Convert a logical selection to physical pixels, clamped to the frame.
pub fn to_pixel_rect(rect: Rect, scale: f64, frame_w: u32, frame_h: u32) -> Result<PixelRect> {
    if !scale.is_finite() || scale <= 0.0 {
        return Err(anyhow!("invalid scale factor {scale}"));
    }
    if !(rect.x.is_finite() && rect.y.is_finite() && rect.width.is_finite() && rect.height.is_finite())
    {
        return Err(anyhow!("selection contains non-finite values"));
    }

    // Round outward so a 1px drag still yields a 1px image and no content is lost.
    let x0 = (rect.x * scale).floor().max(0.0);
    let y0 = (rect.y * scale).floor().max(0.0);
    let x1 = ((rect.x + rect.width) * scale).ceil().min(frame_w as f64);
    let y1 = ((rect.y + rect.height) * scale).ceil().min(frame_h as f64);

    let width = (x1 - x0).max(0.0) as u32;
    let height = (y1 - y0).max(0.0) as u32;
    if width == 0 || height == 0 {
        return Err(anyhow!("selection is empty after clamping to the screen"));
    }
    Ok(PixelRect {
        x: x0 as u32,
        y: y0 as u32,
        width,
        height,
    })
}

/// Crop `frame` to `rect` (physical px).
pub fn crop(frame: &RgbaImage, rect: PixelRect) -> Result<RgbaImage> {
    let (fw, fh) = frame.dimensions();
    if rect.x + rect.width > fw || rect.y + rect.height > fh {
        return Err(anyhow!(
            "crop {rect:?} escapes the frame {fw}x{fh}"
        ));
    }
    Ok(imageops::crop_imm(frame, rect.x, rect.y, rect.width, rect.height).to_image())
}

/// Merge the (transparent) annotation layer over `base`.
///
/// The layer may arrive at a different size when the webview rendered at a
/// different device pixel ratio than the capture; it is resized once here so
/// annotations always line up with the crop.
pub fn merge_overlay(base: &RgbaImage, overlay: Option<&RgbaImage>) -> RgbaImage {
    let Some(overlay) = overlay else {
        return base.clone();
    };
    let resized;
    let layer = if overlay.dimensions() == base.dimensions() {
        overlay
    } else {
        resized = imageops::resize(
            overlay,
            base.width(),
            base.height(),
            imageops::FilterType::Lanczos3,
        );
        &resized
    };

    let mut out = base.clone();
    imageops::overlay(&mut out, layer, 0, 0);
    out
}

/// Encode as PNG.
pub fn to_png(image: &RgbaImage) -> Result<Vec<u8>> {
    let mut buf = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| anyhow!("encode png: {e}"))?;
    Ok(buf.into_inner())
}

/// Decode a data URL (`data:image/png;base64,...`) or raw base64 into an image.
pub fn decode_overlay(payload: Option<&str>) -> Result<Option<RgbaImage>> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let Some(payload) = payload else {
        return Ok(None);
    };
    if payload.trim().is_empty() {
        return Ok(None);
    }
    let b64 = payload
        .split_once("base64,")
        .map(|(_, rest)| rest)
        .unwrap_or(payload);
    let bytes = STANDARD
        .decode(b64.trim())
        .map_err(|e| anyhow!("decode overlay base64: {e}"))?;
    let image = image::load_from_memory(&bytes)
        .map_err(|e| anyhow!("decode overlay image: {e}"))?
        .to_rgba8();
    Ok(Some(image))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, rgba: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(w, h, image::Rgba(rgba))
    }

    #[test]
    fn logical_rect_scales_to_physical_pixels() {
        let r = to_pixel_rect(
            Rect { x: 10.0, y: 20.0, width: 100.0, height: 50.0 },
            2.0,
            2880,
            1800,
        )
        .unwrap();
        assert_eq!(r, PixelRect { x: 20, y: 40, width: 200, height: 100 });
    }

    #[test]
    fn selection_is_clamped_to_the_frame() {
        let r = to_pixel_rect(
            Rect { x: 700.0, y: 400.0, width: 200.0, height: 200.0 },
            1.0,
            800,
            600,
        )
        .unwrap();
        assert_eq!(r, PixelRect { x: 700, y: 400, width: 100, height: 200 });
    }

    #[test]
    fn empty_selection_is_rejected() {
        assert!(to_pixel_rect(
            Rect { x: 5.0, y: 5.0, width: 0.0, height: 10.0 },
            1.0,
            100,
            100
        )
        .is_err());
    }

    #[test]
    fn fractional_rect_rounds_outward() {
        // A sub-pixel drag must still produce at least one pixel of content.
        let r = to_pixel_rect(
            Rect { x: 10.2, y: 10.2, width: 0.3, height: 0.3 },
            2.0,
            100,
            100,
        )
        .unwrap();
        assert_eq!(r.width, 1);
        assert_eq!(r.height, 1);
    }

    #[test]
    fn overlay_is_merged_on_top() {
        let base = solid(4, 4, [255, 0, 0, 255]);
        let mut overlay = solid(4, 4, [0, 0, 0, 0]);
        overlay.put_pixel(1, 1, image::Rgba([0, 0, 255, 255]));
        let out = merge_overlay(&base, Some(&overlay));
        assert_eq!(out.get_pixel(1, 1).0, [0, 0, 255, 255]);
        assert_eq!(out.get_pixel(0, 0).0, [255, 0, 0, 255]);
    }

    #[test]
    fn overlay_of_other_size_is_resized() {
        let base = solid(4, 4, [0, 0, 0, 255]);
        let overlay = solid(2, 2, [255, 255, 255, 255]);
        let out = merge_overlay(&base, Some(&overlay));
        assert_eq!(out.dimensions(), (4, 4));
        assert_eq!(out.get_pixel(3, 3).0, [255, 255, 255, 255]);
    }

    #[test]
    fn png_roundtrip_keeps_dimensions() {
        let img = solid(7, 5, [1, 2, 3, 255]);
        let png = to_png(&img).unwrap();
        let back = image::load_from_memory(&png).unwrap().to_rgba8();
        assert_eq!(back.dimensions(), (7, 5));
    }

    #[test]
    fn empty_overlay_payload_is_none() {
        assert!(decode_overlay(None).unwrap().is_none());
        assert!(decode_overlay(Some("   ")).unwrap().is_none());
    }
}
