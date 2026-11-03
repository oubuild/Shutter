//! 本地识图（OCR）— engine selection, dispatch, and provider metadata.
//!
//! Four extraction engines, mirroring the reference app's picker: cloud (the
//! streaming AI pipeline, routed by the frontend), the macOS Vision framework,
//! and two optional downloadable models run locally through ONNX Runtime.
//! The last selection is persisted in `settings.json` as `ocr_provider`.

pub mod models;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub mod rapid;
#[cfg(target_os = "macos")]
pub mod vision;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

/// The extraction engines, in picker order. The serde ids ("cloud", "system",
/// "ppocr", "qota") are what `settings.json` and the IPC both speak.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OcrProvider {
    Cloud,
    System,
    Ppocr,
    Qota,
}

impl OcrProvider {
    pub fn from_id(id: &str) -> Result<Self> {
        match id {
            "cloud" => Ok(Self::Cloud),
            "system" => Ok(Self::System),
            "ppocr" => Ok(Self::Ppocr),
            "qota" => Ok(Self::Qota),
            other => Err(anyhow!("unknown OCR provider: {other}")),
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Cloud => "cloud",
            Self::System => "system",
            Self::Ppocr => "ppocr",
            Self::Qota => "qota",
        }
    }

    /// Card title in the picker, matching the reference app.
    pub fn title(self) -> &'static str {
        match self {
            Self::Cloud => "云端识别",
            Self::System => "系统识别",
            Self::Ppocr => "模型PP-OCRV6识别",
            Self::Qota => "模型Qota-OCR识别",
        }
    }

    /// One-line capability note under the title.
    pub fn subtitle(self) -> &'static str {
        match self {
            Self::Cloud => "联网调用 API",
            Self::System => "跟随系统模型",
            Self::Ppocr => "中文、繁体中文、英文、日文及拉丁语系",
            Self::Qota => "韩文、中文、日文和英文混合识别",
        }
    }

    /// Download size shown on the model cards.
    pub fn size_label(self) -> Option<&'static str> {
        match self {
            Self::Ppocr => Some("30 MB"),
            Self::Qota => Some("36 MB"),
            _ => None,
        }
    }

    /// The two engines backed by downloadable ONNX models.
    pub fn is_local_model(self) -> bool {
        matches!(self, Self::Ppocr | Self::Qota)
    }
}

/// All providers in picker order (the UI hides unavailable cards).
pub const ALL: [OcrProvider; 4] = [
    OcrProvider::Cloud,
    OcrProvider::System,
    OcrProvider::Ppocr,
    OcrProvider::Qota,
];

/// Result of one extraction run over a PNG crop.
pub struct OcrOutcome {
    pub text: String,
    pub elapsed_ms: u128,
}

/// Run one provider over PNG bytes. Cloud is rejected here on purpose: it is
/// the streaming AI `extract` action, so the frontend routes it to `ai_ask`.
pub async fn extract(provider: OcrProvider, png: Vec<u8>) -> Result<OcrOutcome> {
    match provider {
        OcrProvider::Cloud => Err(anyhow!(
            "云端识别走 AI 流式通道，不经过本地识别"
        )),
        OcrProvider::System => {
            #[cfg(target_os = "macos")]
            {
                let out = run_blocking(vision::extract, png).await?;
                Ok(out)
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = png;
                Err(anyhow!("系统识别仅在 macOS 上可用"))
            }
        }
        OcrProvider::Ppocr | OcrProvider::Qota => {
            #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
            {
                if !models::models_supported() {
                    return Err(anyhow!(
                        "本地模型仅支持 Apple Silicon 且 macOS 13.4 以上的设备"
                    ));
                }
                if !models::is_downloaded(provider) {
                    return Err(anyhow!("模型尚未下载，请先在识别方式中选择下载"));
                }
                run_blocking(move |png| rapid::extract(provider, png), png).await
            }
            #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
            {
                let _ = png;
                Err(anyhow!(
                    "本地模型仅支持 Apple Silicon 且 macOS 13.4 以上的设备"
                ))
            }
        }
    }
}

/// Run a blocking OCR function on the async runtime's thread pool.
async fn run_blocking<F>(f: F, png: Vec<u8>) -> Result<OcrOutcome>
where
    F: FnOnce(&[u8]) -> Result<OcrOutcome> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || f(&png))
        .await
        .map_err(|e| anyhow!("OCR task join error: {e}"))?
}

/// Assemble the picker card list for the current selection.
pub fn providers_info(current: &str) -> Vec<crate::types::OcrProviderInfo> {
    let current = OcrProvider::from_id(current).unwrap_or(OcrProvider::System);
    let supported = models::models_supported();
    ALL.iter()
        .map(|&p| crate::types::OcrProviderInfo {
            id: p.id().into(),
            title: p.title().into(),
            subtitle: p.subtitle().into(),
            size_label: p.size_label().map(str::to_string),
            // Model cards only exist where the models can run; cloud and the
            // system engine are always offered.
            available: !p.is_local_model() || supported,
            downloaded: p.is_local_model() && models::is_downloaded(p),
            current: p == current,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_ids_roundtrip() {
        for p in ALL {
            assert_eq!(OcrProvider::from_id(p.id()).unwrap(), p);
        }
        assert!(OcrProvider::from_id("bogus").is_err());
    }

    #[test]
    fn provider_info_marks_current_and_downloads() {
        let info = providers_info("system");
        assert_eq!(info.len(), 4);
        assert_eq!(info[0].id, "cloud");
        assert!(info[0].available);
        assert!(!info[0].current);
        assert!(info[1].current);
        // Model cards report their download state without claiming a download.
        assert!(info[2].size_label.is_some());
        assert!(!info[2].downloaded);
    }
}
