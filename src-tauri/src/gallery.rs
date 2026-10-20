//! Screenshot gallery: list what is on disk, render thumbnails, delete safely.
//!
//! The gallery owns no database. The save directory is the single source of
//! truth, so a file added by Finder shows up on refresh and a file deleted by
//! hand simply disappears. Only files matching [`is_gallery_name`] are listed:
//! the directory is user-visible and may hold unrelated images.

use crate::types::{GalleryItem, Settings};
use anyhow::{anyhow, Context, Result};
use image::RgbaImage;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Prefix every capture written by [`crate::output::save_png`] carries.
pub const FILE_PREFIX: &str = "shutter-";

/// Prefix used before the rename from cap-photo to Shutter. Files already on
/// disk keep the old name, so the gallery has to recognise both or those
/// screenshots would silently vanish from the list.
pub const LEGACY_FILE_PREFIX: &str = "cap-photo-";

/// Thumbnail edge, in pixels. Big enough for a 3-column grid on a Retina
/// display without making the IPC payload large.
const THUMB_MAX_SIDE: u32 = 480;

/// True when `name` looks like a file this app wrote.
///
/// Deliberately stricter than "ends in .png": the gallery must not offer to
/// delete a user's unrelated screenshot that happens to sit in the folder.
pub fn is_gallery_name(name: &str) -> bool {
    let stem = match name.strip_suffix(".png") {
        Some(stem) => stem,
        None => return false,
    };
    let rest = match stem
        .strip_prefix(FILE_PREFIX)
        .or_else(|| stem.strip_prefix(LEGACY_FILE_PREFIX))
    {
        Some(rest) => rest,
        None => return false,
    };
    // `YYYYMMDD-HHMMSS` optionally followed by `-N`.
    let bytes = rest.as_bytes();
    if bytes.len() < 15 {
        return false;
    }
    let date_ok = bytes[..8].iter().all(u8::is_ascii_digit) && bytes[8] == b'-';
    let time_ok = bytes[9..15].iter().all(u8::is_ascii_digit);
    if !date_ok || !time_ok {
        return false;
    }
    match &rest[15..] {
        "" => true,
        suffix => suffix
            .strip_prefix('-')
            .map(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
            .unwrap_or(false),
    }
}

/// Where thumbnails are cached. Separate from the save directory so deleting a
/// screenshot never leaves junk in the folder the user looks at.
///
/// `CAP_PHOTO_CACHE_DIR` overrides the location; tests use it to stay hermetic
/// instead of writing into the real user cache.
fn default_thumb_dir() -> Result<PathBuf> {
    let base = match std::env::var_os("CAP_PHOTO_CACHE_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => dirs::cache_dir()
            .ok_or_else(|| anyhow!("no cache directory"))?
            .join("Shutter")
            .join("thumbs"),
    };
    std::fs::create_dir_all(&base).with_context(|| format!("create {}", base.display()))?;
    Ok(base)
}

/// Cache key: file name plus mtime and size, so a re-saved file with the same
/// name does not serve a stale thumbnail. Size is part of the key because some
/// filesystems only record mtime at one-second granularity.
fn thumb_path(cache_root: &Path, path: &Path) -> Result<PathBuf> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow!("path has no file name"))?;
    let meta = std::fs::metadata(path).with_context(|| format!("stat {}", path.display()))?;
    let modified = meta
        .modified()
        .with_context(|| format!("mtime {}", path.display()))?;
    let stamp = modified
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Ok(cache_root.join(format!("{stamp}-{}-{name}", meta.len())))
}

fn mtime_secs(path: &Path) -> Result<i64> {
    let modified = std::fs::metadata(path)
        .with_context(|| format!("stat {}", path.display()))?
        .modified()
        .with_context(|| format!("mtime {}", path.display()))?;
    let secs = modified
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    Ok(secs)
}

/// Reject any path that is not a gallery file directly inside `dir`.
///
/// This is the security boundary: the frontend sends paths back, so a crafted
/// or stale path must not be able to delete `~/Documents` or escape the folder.
pub fn resolve_in_dir(dir: &Path, candidate: &str) -> Result<PathBuf> {
    let raw = Path::new(candidate);
    let name = raw
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow!("不是有效的文件路径"))?;

    // Reject anything with a directory component or traversal, even if it would
    // resolve inside `dir` — the gallery only ever deals in bare file names.
    if raw.parent().map(|p| !p.as_os_str().is_empty()).unwrap_or(false)
        || name != candidate
        || !is_gallery_name(name)
    {
        return Err(anyhow!("不是图库中的截图：{candidate}"));
    }

    let path = dir.join(name);
    // Resolve symlinks before touching anything: a symlink in the folder must
    // not redirect a delete outside it.
    let canonical_dir = dir
        .canonicalize()
        .with_context(|| format!("resolve {}", dir.display()))?;
    let canonical = path
        .canonicalize()
        .with_context(|| format!("resolve {}", path.display()))?;
    if canonical.parent() != Some(canonical_dir.as_path()) {
        return Err(anyhow!("路径不在保存目录内：{candidate}"));
    }
    Ok(canonical)
}

/// List every gallery screenshot, newest first.
///
/// A missing directory is not an error: a fresh install has not saved anything
/// yet, and the UI should show an empty state rather than a failure.
pub fn list(settings: &Settings) -> Result<Vec<GalleryItem>> {
    let dir = crate::settings::save_dir_path(settings)?;
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e).with_context(|| format!("read {}", dir.display())),
    };

    let mut items = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                log::warn!("skip unreadable entry in {}: {e}", dir.display());
                continue;
            }
        };
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !path.is_file() || !is_gallery_name(name) {
            continue;
        }

        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(e) => {
                log::warn!("skip {}: {e}", path.display());
                continue;
            }
        };
        // Reading dimensions means decoding the header only, but a corrupt file
        // must not fail the whole listing.
        let (width, height) = match image::image_dimensions(&path) {
            Ok(size) => size,
            Err(e) => {
                log::warn!("skip {}: not a readable image ({e})", path.display());
                continue;
            }
        };

        items.push(GalleryItem {
            path: path.display().to_string(),
            name: name.to_string(),
            width,
            height,
            bytes: meta.len(),
            created_at: mtime_secs(&path).unwrap_or(0),
        });
    }

    items.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.name.cmp(&a.name)));
    Ok(items)
}

/// PNG bytes of a cached thumbnail, generating it on first use.
pub fn thumbnail(settings: &Settings, candidate: &str) -> Result<Vec<u8>> {
    let cache_root = default_thumb_dir()?;
    thumbnail_in(&cache_root, settings, candidate)
}

/// Raw bytes of one gallery file, after the same path validation as deletion.
///
/// Used for the full-size preview and for copying: the thumbnail is far too
/// small to stand in for either.
pub fn read_png(settings: &Settings, candidate: &str) -> Result<Vec<u8>> {
    let dir = crate::settings::save_dir_path(settings)?;
    let path = resolve_in_dir(&dir, candidate)?;
    std::fs::read(&path).with_context(|| format!("read {}", path.display()))
}

/// Testable core of [`thumbnail`], with the cache root injected.
pub fn thumbnail_in(cache_root: &Path, settings: &Settings, candidate: &str) -> Result<Vec<u8>> {
    let dir = crate::settings::save_dir_path(settings)?;
    let path = resolve_in_dir(&dir, candidate)?;
    let cache = thumb_path(cache_root, &path)?;

    if let Ok(bytes) = std::fs::read(&cache) {
        return Ok(bytes);
    }

    let image = image::open(&path)
        .with_context(|| format!("decode {}", path.display()))?
        .to_rgba8();
    let small = resize_to_fit(&image, THUMB_MAX_SIDE);
    let mut buf = std::io::Cursor::new(Vec::new());
    small
        .write_to(&mut buf, image::ImageFormat::Png)
        .context("encode thumbnail")?;
    let bytes = buf.into_inner();

    // A failed cache write is not fatal: the thumbnail is still returned.
    if let Err(e) = std::fs::write(&cache, &bytes) {
        log::warn!("cache thumbnail {}: {e}", cache.display());
    }
    Ok(bytes)
}

/// Scale `image` so its longest side is at most `max_side`, never upscaling.
fn resize_to_fit(image: &RgbaImage, max_side: u32) -> RgbaImage {
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

/// Delete one screenshot and its cached thumbnail.
pub fn delete(settings: &Settings, candidate: &str) -> Result<()> {
    let cache_root = default_thumb_dir()?;
    delete_in(&cache_root, settings, candidate)
}

/// Testable core of [`delete`], with the cache root injected.
pub fn delete_in(cache_root: &Path, settings: &Settings, candidate: &str) -> Result<()> {
    let dir = crate::settings::save_dir_path(settings)?;
    let path = resolve_in_dir(&dir, candidate)?;

    // Capture the cache path before removing the file, since it depends on mtime.
    let cache = thumb_path(cache_root, &path).ok();
    std::fs::remove_file(&path).with_context(|| format!("delete {}", path.display()))?;
    if let Some(cache) = cache {
        let _ = std::fs::remove_file(cache);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "shutter-gallery-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_png(path: &Path, w: u32, h: u32) {
        let img = RgbaImage::from_pixel(w, h, Rgba([10, 20, 30, 255]));
        img.save(path).unwrap();
    }

    #[test]
    fn recognises_our_own_file_names() {
        assert!(is_gallery_name("shutter-20261019-205523.png"));
        assert!(is_gallery_name("shutter-20261019-205523-2.png"));
        assert!(!is_gallery_name("shutter-20261019.png"));
        assert!(!is_gallery_name("Screenshot 2026-10-19.png"));
        assert!(!is_gallery_name("shutter-20261019-205523.jpg"));
        assert!(!is_gallery_name("shutter-2026101-205523.png"));
        assert!(!is_gallery_name("shutter-20261019-205523-extra.png"));
        assert!(!is_gallery_name("shutter-20261019-205523.png.bak"));
    }

    #[test]
    fn recognises_pre_rename_files() {
        // Screenshots saved before the cap-photo -> Shutter rename must stay
        // visible in the gallery instead of silently disappearing.
        assert!(is_gallery_name("cap-photo-20261019-205523.png"));
        assert!(is_gallery_name("cap-photo-20261019-205523-1.png"));
        assert!(!is_gallery_name("cap-photo-20261019-205523-1-2.png"));
    }

    #[test]
    fn lists_only_gallery_files_newest_first() {
        let dir = temp_dir("list");
        write_png(&dir.join("shutter-20260101-000000.png"), 4, 4);
        write_png(&dir.join("shutter-20260102-000000.png"), 6, 4);
        write_png(&dir.join("unrelated.png"), 4, 4);
        std::fs::write(dir.join("notes.txt"), b"hello").unwrap();

        let mut settings = Settings::default();
        settings.save_dir = Some(dir.display().to_string());
        let items = list(&settings).unwrap();

        assert_eq!(items.len(), 2, "unrelated files must be ignored");
        assert!(items.iter().all(|i| i.name.starts_with(FILE_PREFIX)));
        assert_eq!(items[0].width, 6);
        assert_eq!(items[1].width, 4);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_directory_lists_empty() {
        let mut settings = Settings::default();
        settings.save_dir = Some("/nonexistent/shutter-test-dir".into());
        assert!(list(&settings).unwrap().is_empty());
    }

    #[test]
    fn rejects_paths_outside_the_save_directory() {
        let dir = temp_dir("escape");
        write_png(&dir.join("shutter-20260101-000000.png"), 4, 4);

        for bad in [
            "../shutter-20260101-000000.png",
            "/etc/shutter-20260101-000000.png",
            "sub/shutter-20260101-000000.png",
            "unrelated.png",
            ".",
        ] {
            assert!(
                resolve_in_dir(&dir, bad).is_err(),
                "{bad} must be rejected"
            );
        }
        assert!(resolve_in_dir(&dir, "shutter-20260101-000000.png").is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn delete_removes_the_file_and_is_idempotent_for_the_cache() {
        let dir = temp_dir("delete");
        let cache = temp_dir("delete-cache");
        let name = "shutter-20260101-000000.png";
        write_png(&dir.join(name), 4, 4);

        let mut settings = Settings::default();
        settings.save_dir = Some(dir.display().to_string());

        // Generate the thumbnail so there is a cache entry to clean up.
        let bytes = thumbnail_in(&cache, &settings, name).unwrap();
        assert!(!bytes.is_empty());
        let cached = thumb_path(&cache, &dir.join(name)).unwrap();
        assert!(cached.exists());

        delete_in(&cache, &settings, name).unwrap();
        assert!(!dir.join(name).exists());
        assert!(!cached.exists(), "the thumbnail cache must be cleaned up too");
        assert!(list(&settings).unwrap().is_empty());

        // Deleting again reports the missing file rather than panicking.
        assert!(delete_in(&cache, &settings, name).is_err());
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn thumbnail_is_capped_and_not_upscaled() {
        let dir = temp_dir("thumb");
        let cache = temp_dir("thumb-cache");
        let big = "shutter-20260101-000000.png";
        let small = "shutter-20260101-000001.png";
        write_png(&dir.join(big), 1600, 400);
        write_png(&dir.join(small), 40, 20);

        let mut settings = Settings::default();
        settings.save_dir = Some(dir.display().to_string());

        let decoded = image::load_from_memory(&thumbnail_in(&cache, &settings, big).unwrap()).unwrap();
        assert_eq!(decoded.width(), THUMB_MAX_SIDE);
        assert_eq!(decoded.height(), THUMB_MAX_SIDE / 4);

        let decoded = image::load_from_memory(&thumbnail_in(&cache, &settings, small).unwrap()).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (40, 20));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&cache).ok();
    }

    #[test]
    fn thumbnail_cache_is_reused_until_the_file_changes() {
        let dir = temp_dir("cache");
        let cache = temp_dir("cache-cache");
        let name = "shutter-20260101-000000.png";
        write_png(&dir.join(name), 100, 100);

        let mut settings = Settings::default();
        settings.save_dir = Some(dir.display().to_string());

        let first = thumbnail_in(&cache, &settings, name).unwrap();
        let cached = thumb_path(&cache, &dir.join(name)).unwrap();
        assert!(cached.exists());

        // A second call serves the cached bytes, not a fresh decode.
        std::fs::write(&cached, b"sentinel").unwrap();
        assert_eq!(thumbnail_in(&cache, &settings, name).unwrap(), b"sentinel");

        // Changing the source file invalidates the key, so it re-decodes.
        write_png(&dir.join(name), 120, 120);
        let regenerated = thumbnail_in(&cache, &settings, name).unwrap();
        assert_ne!(regenerated, b"sentinel");
        assert!(!first.is_empty());
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&cache).ok();
    }
}
