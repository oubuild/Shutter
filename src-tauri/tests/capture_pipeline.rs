//! End-to-end capture pipeline tests against the real screen.
//!
//! These run only with `--ignored` because they need Screen Recording
//! permission and a live display:
//!
//! ```text
//! cargo test --test capture_pipeline -- --ignored --nocapture
//! ```
//!
//! They assert geometry and pixel identity rather than visual content, so they
//! stay meaningful on any wallpaper.

use shutter_lib::capture;
use shutter_lib::compose;
use shutter_lib::output;
use shutter_lib::types::Rect;

/// Every display reports consistent logical/physical dimensions.
#[test]
#[ignore]
fn displays_report_consistent_geometry() {
    let displays = capture::displays().expect("enumerate displays");
    assert!(!displays.is_empty(), "at least one display expected");
    assert_eq!(
        displays.iter().filter(|d| d.info.is_primary).count(),
        1,
        "exactly one primary display"
    );

    for d in &displays {
        let info = &d.info;
        println!(
            "{} '{}' {}x{}pt @ {},{} scale {} -> {}x{}px",
            info.id,
            info.name,
            info.width,
            info.height,
            info.x,
            info.y,
            info.scale_factor,
            info.pixel_width,
            info.pixel_height
        );
        assert!(info.width > 0 && info.height > 0);
        assert!(info.scale_factor >= 1.0 && info.scale_factor <= 4.0);
        assert_eq!(
            info.pixel_width,
            (info.width as f64 * info.scale_factor).round() as u32
        );
        assert_eq!(
            info.pixel_height,
            (info.height as f64 * info.scale_factor).round() as u32
        );
    }
}

/// The captured frame matches the declared physical size exactly.
#[test]
#[ignore]
fn captured_frame_matches_declared_pixel_size() {
    let displays = capture::displays().expect("displays");
    for d in &displays {
        let frame = d.capture().expect("capture");
        println!(
            "monitor {}: frame {}x{} vs declared {}x{}",
            d.info.id,
            frame.width(),
            frame.height(),
            d.info.pixel_width,
            d.info.pixel_height
        );
        assert_eq!(frame.width(), d.info.pixel_width);
        assert_eq!(frame.height(), d.info.pixel_height);
    }
}

/// A logical selection maps onto the exact pixels it visually covers.
///
/// This is the check that catches Retina off-by-one bugs: crop at a logical
/// rect, then verify the cropped pixel at (0,0) equals the source pixel at the
/// scaled coordinate.
#[test]
#[ignore]
fn logical_selection_maps_to_expected_pixels() {
    let displays = capture::displays().expect("displays");
    let d = &displays[0];
    let frame = d.capture().expect("capture");
    let scale = d.info.scale_factor;

    let logical = Rect { x: 40.0, y: 30.0, width: 120.0, height: 80.0 };
    let rect = compose::to_pixel_rect(logical, scale, frame.width(), frame.height()).expect("rect");
    println!("logical {logical:?} @ scale {scale} -> {rect:?}");
    assert_eq!(rect.x, (logical.x * scale) as u32);
    assert_eq!(rect.y, (logical.y * scale) as u32);
    assert_eq!(rect.width, (logical.width * scale) as u32);
    assert_eq!(rect.height, (logical.height * scale) as u32);

    let cropped = compose::crop(&frame, rect).expect("crop");
    assert_eq!(cropped.dimensions(), (rect.width, rect.height));

    // Corner pixel must be the same pixel, not a neighbour.
    let src = frame.get_pixel(rect.x, rect.y);
    let dst = cropped.get_pixel(0, 0);
    assert_eq!(src, dst, "crop origin must map 1:1 to the source pixel");

    let src_br = frame.get_pixel(rect.x + rect.width - 1, rect.y + rect.height - 1);
    let dst_br = cropped.get_pixel(rect.width - 1, rect.height - 1);
    assert_eq!(src_br, dst_br, "crop bottom-right must map 1:1");
}

/// Full path: capture -> crop -> merge overlay -> PNG -> file, with the overlay
/// pixel surviving the round trip.
#[test]
#[ignore]
fn overlay_is_baked_into_the_saved_png() {
    use image::Rgba;

    let displays = capture::displays().expect("displays");
    let d = &displays[0];
    let frame = d.capture().expect("capture");
    let scale = d.info.scale_factor;

    let rect = compose::to_pixel_rect(
        Rect { x: 10.0, y: 10.0, width: 64.0, height: 48.0 },
        scale,
        frame.width(),
        frame.height(),
    )
    .expect("rect");
    let cropped = compose::crop(&frame, rect).expect("crop");

    // Paint a magenta pixel at the crop's centre in the overlay layer.
    let mut overlay = image::RgbaImage::from_pixel(rect.width, rect.height, Rgba([0, 0, 0, 0]));
    let (cx, cy) = (rect.width / 2, rect.height / 2);
    overlay.put_pixel(cx, cy, Rgba([255, 0, 255, 255]));

    let merged = compose::merge_overlay(&cropped, Some(&overlay));
    let png = compose::to_png(&merged).expect("png");

    let dir = std::env::temp_dir().join(format!("shutter-e2e-{}", std::process::id()));
    let path = output::save_png(&png, &dir).expect("save");
    println!("saved {}", path.display());

    let reread = image::open(&path).expect("reopen").to_rgba8();
    assert_eq!(reread.dimensions(), (rect.width, rect.height));
    assert_eq!(
        reread.get_pixel(cx, cy).0,
        [255, 0, 255, 255],
        "overlay pixel must survive encode/decode"
    );

    // The preview must stay small while the saved file keeps full resolution.
    let thumb = output::thumbnail(&merged, 32);
    assert!(thumb.width() <= 32 && thumb.height() <= 32);

    std::fs::remove_dir_all(&dir).ok();
}

/// Out-of-bounds selections are clamped, never panic or wrap.
#[test]
#[ignore]
fn oversized_selection_is_clamped_not_panicking() {
    let displays = capture::displays().expect("displays");
    let d = &displays[0];
    let frame = d.capture().expect("capture");
    let scale = d.info.scale_factor;

    let rect = compose::to_pixel_rect(
        Rect {
            x: d.info.width as f64 - 20.0,
            y: d.info.height as f64 - 20.0,
            width: 5000.0,
            height: 5000.0,
        },
        scale,
        frame.width(),
        frame.height(),
    )
    .expect("clamped rect");

    assert!(rect.x + rect.width <= frame.width());
    assert!(rect.y + rect.height <= frame.height());
    let cropped = compose::crop(&frame, rect).expect("crop");
    assert!(cropped.width() > 0 && cropped.height() > 0);
}
