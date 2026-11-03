//! Local OCR through rapidocr-core (ONNX Runtime) for the two optional
//! downloadable models.
//!
//! Both providers run the RapidOCR det + rec pipeline; they differ only in the
//! recognition model and dictionary. Engines are cached per provider because
//! building the ONNX sessions is the expensive part — running the cached
//! engine is what every extraction after the first pays for.

use super::{OcrOutcome, OcrProvider};
use anyhow::{Context, Result};
use rapidocr_core::config::RapidOcrConfig;
use rapidocr_core::RapidOcr;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

/// Built engines, keyed by provider. The map itself is a `OnceLock` static
/// like the scroll session store; the outer lock is held across a run because
/// ONNX session execution is stateful (`&mut self`).
static ENGINES: OnceLock<Mutex<HashMap<OcrProvider, RapidOcr>>> = OnceLock::new();

fn engines() -> &'static Mutex<HashMap<OcrProvider, RapidOcr>> {
    ENGINES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Drop a cached engine so the next run reloads from disk (after a fresh
/// model download, or from tests).
pub fn invalidate(provider: OcrProvider) {
    if let Some(map) = ENGINES.get() {
        map.lock().unwrap().remove(&provider);
    }
}

/// Assemble the config for one provider rooted at the model dir. PP-OCRv6
/// small defaults come from rapidocr-core itself; Qota swaps in its own
/// recognition model, dictionary, and (when the config states one) shape.
fn build_config(provider: OcrProvider) -> Result<RapidOcrConfig> {
    let dir = super::models::model_dir()?;
    let mut config = RapidOcrConfig::ppocr_v6_small(&dir);
    // The downloadable manifest ships no orientation classifier, so the cls
    // stage must not be a required asset.
    config.pipeline.use_cls = false;
    config.cls = None;

    if matches!(provider, OcrProvider::Qota) {
        let rec = config
            .rec
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("ppocr_v6_small config has no rec stage"))?;
        rec.model_path = dir.join("qota_ocr_rec.onnx");
        rec.dict_path = dir.join("qota_ocr_dict.txt");
        if let Some(shape) = qota_image_shape(&dir)? {
            rec.image_shape = shape;
        }
    }
    Ok(config)
}

/// Qota's preprocessor config may pin a `[channels, height, width]` input
/// shape; absent or odd-shaped values keep the PP-OCRv6 default.
fn qota_image_shape(dir: &std::path::Path) -> Result<Option<[usize; 3]>> {
    let path = dir.join("qota_ocr_preprocessor_config.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(None);
    };
    let config: serde_json::Value = serde_json::from_str(&text).context("parse qota preprocessor config")?;
    let Some(shape) = config.get("image_size").and_then(|v| v.as_array()) else {
        return Ok(None);
    };
    if shape.len() != 3 {
        return Ok(None);
    }
    let mut out = [0usize; 3];
    for (slot, value) in out.iter_mut().zip(shape) {
        let dimension = value
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .filter(|n| *n > 0)
            .ok_or_else(|| anyhow::anyhow!("qota image_size has a non-positive entry"))?;
        *slot = dimension;
    }
    Ok(Some(out))
}

/// Run one provider over PNG bytes. The engine builds (or rebuilds) on first
/// use; a build failure is reported without being cached.
pub fn extract(provider: OcrProvider, png: &[u8]) -> Result<OcrOutcome> {
    let image = image::load_from_memory(png)
        .context("decode crop")
        .map_err(|e| anyhow::anyhow!("{e:#}"))?
        .to_rgb8();

    let started = Instant::now();
    let mut engines = engines().lock().unwrap();
    if !engines.contains_key(&provider) {
        let config = build_config(provider)?;
        let engine = RapidOcr::new(config).context("load OCR model")?;
        engines.insert(provider, engine);
    }
    let engine = engines
        .get_mut(&provider)
        .expect("engine was just inserted");
    let output = engine.run_image(&image).context("run OCR")?;
    let text = output
        .lines
        .iter()
        .map(|line| line.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    Ok(OcrOutcome {
        text,
        elapsed_ms: started.elapsed().as_millis(),
    })
}
