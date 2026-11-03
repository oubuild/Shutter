//! Live model tests — real downloads from the pinned sources plus real ONNX
//! inference. Never part of the default suite (`--ignored`), mirroring
//! `live_deepseek_vision_round_trip` in ai_stream.rs.

use shutter_lib::ocr::{self, models, OcrProvider};
use std::sync::Mutex;

/// The model dir override is process-wide env, so the live tests must not
/// overlap: one would delete the other's scratch directory mid-download.
static LIVE: Mutex<()> = Mutex::new(());

fn blank_png() -> Vec<u8> {
    let mut png = Vec::new();
    let image = image::RgbImage::from_pixel(64, 32, image::Rgb([255u8, 255, 255]));
    image::DynamicImage::ImageRgb8(image)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .expect("encode blank png");
    png
}

async fn download_and_run(provider: OcrProvider) {
    let _guard = LIVE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let dir = std::env::temp_dir().join(format!(
        "shutter-ocr-live-{}-{:?}",
        std::process::id(),
        provider
    ));
    std::env::set_var("SHUTTER_OCR_MODEL_DIR", &dir);
    let outcome = run(provider, &dir).await;
    std::env::remove_var("SHUTTER_OCR_MODEL_DIR");
    std::fs::remove_dir_all(&dir).ok();
    outcome.expect("live run")
}

async fn run(provider: OcrProvider, _dir: &std::path::Path) -> Result<(), String> {
    models::download(provider, |_, _, _| {})
        .await
        .map_err(|e| format!("download models: {e:#}"))?;
    if !models::is_downloaded(provider) {
        return Err("all artifacts installed".into());
    }
    let outcome = ocr::extract(provider, blank_png())
        .await
        .map_err(|e| format!("run local engine: {e:#}"))?;
    if outcome.text != "" {
        return Err("a blank image has no text".into());
    }
    Ok(())
}

#[tokio::test]
#[ignore = "downloads ~30 MB from ModelScope/hf-mirror and runs ONNX Runtime"]
async fn ppocr_downloads_and_runs() {
    download_and_run(OcrProvider::Ppocr).await;
}

#[tokio::test]
#[ignore = "downloads ~36 MB from hf-mirror/Hugging Face and runs ONNX Runtime"]
async fn qota_downloads_and_runs() {
    download_and_run(OcrProvider::Qota).await;
}
