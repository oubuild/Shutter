//! Clipboard and file output.

use anyhow::{anyhow, Context, Result};
use image::RgbaImage;
use std::path::{Path, PathBuf};

/// Put a PNG on the clipboard as an image.
pub fn copy_image(png: &[u8]) -> Result<()> {
    let img = image::load_from_memory(png)
        .context("decode png for clipboard")?
        .to_rgba8();
    let (w, h) = img.dimensions();
    let mut clipboard = arboard::Clipboard::new().context("open clipboard")?;
    clipboard
        .set_image(arboard::ImageData {
            width: w as usize,
            height: h as usize,
            bytes: std::borrow::Cow::Borrowed(img.as_raw()),
        })
        .context("write image to clipboard")
}

pub fn copy_text(text: &str) -> Result<()> {
    let mut clipboard = arboard::Clipboard::new().context("open clipboard")?;
    clipboard.set_text(text.to_owned()).context("write text")?;
    Ok(())
}

/// Write a PNG into `dir` with a timestamped name, returning the path.
///
/// The name is `cap-photo-YYYYMMDD-HHMMSS.png`, with a numeric suffix if two
/// captures land in the same second.
pub fn save_png(png: &[u8], dir: &Path) -> Result<PathBuf> {
    std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let mut path = dir.join(format!("cap-photo-{stamp}.png"));
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("cap-photo-{stamp}-{n}.png"));
        n += 1;
        if n > 999 {
            return Err(anyhow!("too many captures in the same second"));
        }
    }
    std::fs::write(&path, png).with_context(|| format!("write {}", path.display()))?;
    Ok(path)
}

/// Small PNG data URL so the UI can show the result without another IPC round-trip.
pub fn data_url(png: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    format!("data:image/png;base64,{}", STANDARD.encode(png))
}

/// Downscale for the preview/thumbnail so IPC payloads stay small.
pub fn thumbnail(image: &RgbaImage, max_side: u32) -> RgbaImage {
    let (w, h) = image.dimensions();
    let longest = w.max(h);
    if longest <= max_side {
        return image.clone();
    }
    let ratio = max_side as f32 / longest as f32;
    let nw = (w as f32 * ratio).round().max(1.0) as u32;
    let nh = (h as f32 * ratio).round().max(1.0) as u32;
    image::imageops::resize(image, nw, nh, image::imageops::FilterType::Triangle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_png_creates_unique_names() {
        let dir = std::env::temp_dir().join(format!("cap-photo-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let png = {
            let img = RgbaImage::from_pixel(2, 2, image::Rgba([1, 2, 3, 255]));
            let mut buf = std::io::Cursor::new(Vec::new());
            img.write_to(&mut buf, image::ImageFormat::Png).unwrap();
            buf.into_inner()
        };
        let a = save_png(&png, &dir).unwrap();
        let b = save_png(&png, &dir).unwrap();
        assert!(a.exists() && b.exists());
        assert_ne!(a, b, "same-second captures must not overwrite each other");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn thumbnail_keeps_aspect_ratio() {
        let img = RgbaImage::new(400, 100);
        let thumb = thumbnail(&img, 100);
        assert_eq!(thumb.dimensions(), (100, 25));
    }

    #[test]
    fn small_images_are_not_upscaled() {
        let img = RgbaImage::new(50, 50);
        assert_eq!(thumbnail(&img, 100).dimensions(), (50, 50));
    }

    #[test]
    fn data_url_is_png_base64() {
        assert!(data_url(b"abc").starts_with("data:image/png;base64,"));
    }
}
