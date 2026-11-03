//! System OCR engine: the macOS Vision framework's `VNRecognizeTextRequest`.
//!
//! This is the default provider — zero downloads, follows the system model.
//! Each observation is one text region; we take its top candidate and join
//! the regions with newlines.

use super::OcrOutcome;
use anyhow::{anyhow, Context, Result};
use std::time::Instant;

pub fn extract(png: &[u8]) -> Result<OcrOutcome> {
    let started = Instant::now();
    let text = unsafe { recognize(png) }.context("系统识别")?;
    Ok(OcrOutcome {
        text,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

/// The unsafe Vision round trip: handler over PNG data → one text request →
/// top candidate per observation.
unsafe fn recognize(png: &[u8]) -> Result<String> {
    use objc2::rc::Retained;
    use objc2::AnyThread as _;
    use objc2_foundation::{NSArray, NSData, NSDictionary, NSString};
    use objc2_vision::{
        VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel,
    };

    let request = VNRecognizeTextRequest::new();
    request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
    let languages = NSArray::from_retained_slice(&[
        NSString::from_str("zh-Hans"),
        NSString::from_str("zh-Hant"),
        NSString::from_str("ja-JP"),
        NSString::from_str("en-US"),
    ]);
    request.setRecognitionLanguages(&languages);

    let data = NSData::with_bytes(png);
    let handler = VNImageRequestHandler::initWithData_options(
        VNImageRequestHandler::alloc(),
        &data,
        &NSDictionary::new(),
    );
    // `performRequests` wants the superclass array; widening a Retained from
    // subclass to superclass is always sound.
    let requests = NSArray::from_retained_slice(&[Retained::cast_unchecked::<VNRequest>(
        request.clone(),
    )]);
    handler
        .performRequests_error(&requests)
        .map_err(|e| anyhow!("系统识别失败: {e}"))?;

    let mut lines = Vec::new();
    if let Some(observations) = request.results() {
        for observation in observations.iter() {
            let candidates = observation.topCandidates(1);
            if candidates.count() > 0 {
                lines.push(candidates.objectAtIndex(0).string().to_string());
            }
        }
    }
    Ok(lines.join("\n"))
}

#[cfg(target_os = "macos")]
#[cfg(test)]
mod tests {
    use super::*;

    /// A real Vision round trip on a blank PNG: no text to find, but the
    /// handler, request, and results plumbing all execute against the live
    /// framework. Hermetic (no network, no permissions), so it runs with the
    /// normal suite on macOS.
    #[test]
    fn blank_image_recognizes_nothing() {
        let mut png = Vec::new();
        let image = image::RgbImage::from_pixel(64, 32, image::Rgb([255u8, 255, 255]));
        image::DynamicImage::ImageRgb8(image)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .expect("encode blank png");
        let outcome = extract(&png).expect("vision extract");
        assert_eq!(outcome.text, "");
    }
}
