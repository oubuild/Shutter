//! Pinned manifest of the optional local OCR models, plus verified downloads.
//!
//! Model weights never ship in the installer: the user downloads them from
//! the pinned sources below, and an artifact is only installed when its
//! SHA-256 matches — a mismatch is refused and cannot replace an existing
//! file. The same manifest serves PP-OCRv6 small and Qota-OCR (which reuses
//! the PP-OCRv6 detection model and generates its dictionary locally).

use super::OcrProvider;
use anyhow::{anyhow, Context, Result};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// One downloadable file: pinned sources (primary, then fallbacks) and the
/// SHA-256 an installed copy must match.
pub struct Artifact {
    pub filename: &'static str,
    pub sha256: &'static str,
    pub urls: &'static [&'static str],
}

/// 1:1 with the reference app's `MODEL-SOURCES.md` (RapidOCR v3.10.0 on
/// ModelScope, hf-mirror pinned commit as fallback).
const DET_SMALL: Artifact = Artifact {
    filename: "PP-OCRv6_det_small.onnx",
    sha256: "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f",
    urls: &[
        "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx",
        "https://hf-mirror.com/DjB314/RapidOCR/resolve/04e88d0483f0bfcdd0f29429594244c10bfc2867/v3.9.2/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx",
    ],
};

const REC_SMALL: Artifact = Artifact {
    filename: "PP-OCRv6_rec_small.onnx",
    sha256: "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884",
    urls: &[
        "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx",
        "https://hf-mirror.com/DjB314/RapidOCR/resolve/04e88d0483f0bfcdd0f29429594244c10bfc2867/v3.9.2/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx",
    ],
};

const PPOCRV6_DICT: Artifact = Artifact {
    filename: "ppocrv6_dict.txt",
    sha256: "b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d",
    urls: &[
        "https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/paddle/PP-OCRv6/rec/PP-OCRv6_rec_small/ppocrv6_dict.txt",
        "https://hf-mirror.com/DjB314/RapidOCR/resolve/04e88d0483f0bfcdd0f29429594244c10bfc2867/v3.9.2/paddle/PP-OCRv6/rec/PP-OCRv6_rec_small/ppocrv6_dict.txt",
    ],
};

/// Qota-OCR reuses the PP-OCRv6 small detector; its recognition model and
/// character list come from the pinned Hugging Face commit (hf-mirror first).
const QOTA_REC: Artifact = Artifact {
    filename: "qota_ocr_rec.onnx",
    sha256: "27ccd15d20a753652273a49e36b75530477687738dd503edce5f4e2b819a4d36",
    urls: &[
        "https://hf-mirror.com/atonlee/Qota-OCR/resolve/b3e644a61b307b55d82839016576cbee03670d58/onnx/model.onnx",
        "https://huggingface.co/atonlee/Qota-OCR/resolve/b3e644a61b307b55d82839016576cbee03670d58/onnx/model.onnx",
    ],
};

const QOTA_CONFIG: Artifact = Artifact {
    filename: "qota_ocr_preprocessor_config.json",
    sha256: "fffcd60e1d556f2529efeb026797bbea269951c0f633812852c2aa33aa42e460",
    urls: &[
        "https://hf-mirror.com/atonlee/Qota-OCR/resolve/b3e644a61b307b55d82839016576cbee03670d58/preprocessor_config.json",
        "https://huggingface.co/atonlee/Qota-OCR/resolve/b3e644a61b307b55d82839016576cbee03670d58/preprocessor_config.json",
    ],
};

/// The files a provider needs on disk. `qota_ocr_dict.txt` is not listed: it
/// is generated locally from the verified preprocessor config.
pub fn manifest_for(provider: OcrProvider) -> &'static [Artifact] {
    match provider {
        OcrProvider::Ppocr => &[DET_SMALL, REC_SMALL, PPOCRV6_DICT],
        OcrProvider::Qota => &[DET_SMALL, QOTA_REC, QOTA_CONFIG],
        _ => &[],
    }
}

/// Where the optional models live (created on demand): the app's data dir,
/// never inside the .app bundle. `SHUTTER_OCR_MODEL_DIR` overrides it so live
/// tests can download into a scratch directory instead of the user's.
pub fn model_dir() -> Result<PathBuf> {
    if let Ok(dir) = std::env::var("SHUTTER_OCR_MODEL_DIR") {
        let dir = PathBuf::from(dir);
        std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
        return Ok(dir);
    }
    Ok(crate::settings::app_dir()?.join("ocr-models"))
}

/// The model engines are offered on Apple Silicon Macs running macOS 13.4+,
/// mirroring the reference app. Everywhere else the picker shows only cloud
/// and system OCR.
pub fn models_supported() -> bool {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        macos_at_least(13, 4)
    }
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    {
        false
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn macos_at_least(major: isize, minor: isize) -> bool {
    use objc2_foundation::NSProcessInfo;
    let version = NSProcessInfo::processInfo().operatingSystemVersion();
    version.majorVersion > major
        || (version.majorVersion == major && version.minorVersion >= minor)
}

fn sha256_file(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

/// Existence check for the picker cards; hashes are re-verified when a
/// download runs, not on every card refresh (30+ MB per pass).
pub fn is_downloaded(provider: OcrProvider) -> bool {
    let Ok(dir) = model_dir() else {
        return false;
    };
    manifest_for(provider)
        .iter()
        .all(|a| dir.join(a.filename).is_file())
        && (!matches!(provider, OcrProvider::Qota) || dir.join("qota_ocr_dict.txt").is_file())
}

/// Download the provider's artifacts, verifying each against its pinned
/// SHA-256 before it can land. `progress` receives per-file byte counts so the
/// UI can render them; it is a plain closure (no Tauri types) so tests can
/// drive the same code path against a local server.
pub async fn download<F>(provider: OcrProvider, progress: F) -> Result<()>
where
    F: Fn(&str, u64, Option<u64>) + Send + Sync,
{
    let dir = model_dir()?;
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;

    for artifact in manifest_for(provider) {
        let dest = dir.join(artifact.filename);
        if dest.is_file() && sha256_file(&dest).map(|h| h == artifact.sha256).unwrap_or(false) {
            continue; // already installed and verified
        }
        fetch_artifact(artifact, &dest, &progress).await?;
    }

    if matches!(provider, OcrProvider::Qota) {
        generate_qota_dict(&dir)?;
    }

    // Fresh models must not run through a stale cached session.
    super::rapid::invalidate(provider);
    Ok(())
}

/// Stream one artifact to `dest` through a `.part` file, hashing as the bytes
/// arrive. On a SHA-256 mismatch the partial file is removed and the existing
/// destination (if any) is left untouched.
///
/// Public because it is the testable core of [`download`]: integration tests
/// drive it against a local server with their own `Artifact`.
pub async fn fetch_artifact<F>(artifact: &Artifact, dest: &Path, progress: &F) -> Result<()>
where
    F: Fn(&str, u64, Option<u64>) + Send + Sync,
{
    let part = dest.with_extension("part");
    let name = artifact.filename;
    let mut last_error = anyhow!("no source URLs for {name}");

    for url in artifact.urls {
        match fetch_one(url, artifact, &part, progress).await {
            Ok(()) => {
                std::fs::rename(&part, dest)
                    .with_context(|| format!("install {}", dest.display()))?;
                return Ok(());
            }
            Err(e) => {
                let _ = std::fs::remove_file(&part);
                log::warn!("{name}: {url} failed ({e:#}); trying the next source");
                last_error = e;
            }
        }
    }
    Err(last_error).with_context(|| format!("download {name}"))
}

async fn fetch_one<F>(
    url: &str,
    artifact: &Artifact,
    part: &Path,
    progress: &F,
) -> Result<()>
where
    F: Fn(&str, u64, Option<u64>) + Send + Sync,
{
    use futures_util::StreamExt;

    // Remote model hosts benefit from the system proxy; loopback never does
    // (same reasoning as the AI transports: a proxy would hijack or leak
    // local traffic).
    let mut builder = reqwest::Client::builder();
    if crate::ai::is_loopback(url) {
        builder = builder.no_proxy();
    }
    let client = builder.build().context("build http client")?;

    let response = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("connect {url}"))?;
    if !response.status().is_success() {
        return Err(anyhow!("{url} returned {}", response.status()));
    }
    let total = response.content_length();
    let mut file = std::fs::File::create(part).with_context(|| format!("create {}", part.display()))?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.with_context(|| format!("read {url}"))?;
        use std::io::Write as _;
        file.write_all(&chunk)?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        progress(artifact.filename, downloaded, total);
    }
    file.sync_all().ok();

    let got = format!("{:x}", hasher.finalize());
    if !got.eq_ignore_ascii_case(artifact.sha256) {
        return Err(anyhow!(
            "SHA-256 校验失败（{} 期望 {}，实际 {}）",
            artifact.filename,
            &artifact.sha256[..12],
            &got[..12]
        ));
    }
    Ok(())
}

/// Build `qota_ocr_dict.txt` from the verified preprocessor config's
/// `character_list` — the dictionary is generated locally, never downloaded.
fn generate_qota_dict(dir: &Path) -> Result<()> {
    let config_path = dir.join(QOTA_CONFIG.filename);
    let config: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&config_path)
            .with_context(|| format!("read {}", config_path.display()))?,
    )
    .context("parse qota preprocessor config")?;
    let chars = config
        .get("character_list")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow!("preprocessor config has no character_list"))?;
    let mut dict = String::new();
    for ch in chars {
        let ch = ch.as_str().ok_or_else(|| anyhow!("character_list entry is not a string"))?;
        dict.push_str(ch);
        dict.push('\n');
    }
    let dict_path = dir.join("qota_ocr_dict.txt");
    crate::output::atomic_write(&dict_path, dict.as_bytes())
        .with_context(|| format!("write {}", dict_path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifests_share_the_detector() {
        let ppocr: Vec<&str> = manifest_for(OcrProvider::Ppocr).iter().map(|a| a.filename).collect();
        let qota: Vec<&str> = manifest_for(OcrProvider::Qota).iter().map(|a| a.filename).collect();
        assert_eq!(ppocr, vec!["PP-OCRv6_det_small.onnx", "PP-OCRv6_rec_small.onnx", "ppocrv6_dict.txt"]);
        assert_eq!(qota, vec!["PP-OCRv6_det_small.onnx", "qota_ocr_rec.onnx", "qota_ocr_preprocessor_config.json"]);
    }

    #[test]
    fn qota_dict_is_generated_from_character_list() {
        let dir = std::env::temp_dir().join(format!("shutter-ocr-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("qota_ocr_preprocessor_config.json"),
            r#"{"character_list": ["深", "圳", "a", "한"]}"#,
        )
        .unwrap();
        generate_qota_dict(&dir).unwrap();
        let dict = std::fs::read_to_string(dir.join("qota_ocr_dict.txt")).unwrap();
        assert_eq!(dict, "深\n圳\na\n한\n");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sha256_file_matches_known_vector() {
        let dir = std::env::temp_dir().join(format!("shutter-ocr-sha-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("vector.bin");
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(
            sha256_file(&path).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
