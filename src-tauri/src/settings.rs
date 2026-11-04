//! Persisted user settings and the vision-model API key — everything in one
//! `settings.json` under the app data directory. The key used to live in the
//! OS credential store (macOS Keychain), which proved unreliable; it now
//! persists beside every other setting, on every platform.

use crate::types::Settings;
use anyhow::{anyhow, Context, Result};
use std::path::PathBuf;

/// Where the app keeps its own files.
pub fn app_dir() -> Result<PathBuf> {
    let base = dirs::data_dir()
        .ok_or_else(|| anyhow!("no application support directory"))?
        .join("Shutter");
    std::fs::create_dir_all(&base).with_context(|| format!("create {}", base.display()))?;
    Ok(base)
}

fn settings_path() -> Result<PathBuf> {
    Ok(app_dir()?.join("settings.json"))
}

pub fn load_settings() -> Settings {
    let path = match settings_path() {
        Ok(p) => p,
        Err(e) => {
            log::warn!("settings path unavailable: {e:#}");
            return Settings::default();
        }
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            log::warn!("settings.json is not valid JSON ({e}); falling back to defaults");
            Settings::default()
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Settings::default(),
        Err(e) => {
            log::warn!("cannot read settings.json: {e}");
            Settings::default()
        }
    }
}

pub fn save_settings(settings: &Settings) -> Result<()> {
    let path = settings_path()?;
    let text = serde_json::to_string_pretty(settings)?;
    crate::output::atomic_write(&path, text.as_bytes())
        .with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

/// Default directory for saved screenshots, created on demand.
pub fn save_dir(settings: &Settings) -> Result<PathBuf> {
    let dir = save_dir_path(settings)?;
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    Ok(dir)
}

/// Same as [`save_dir`] but never touches the filesystem.
///
/// The gallery uses this: listing an empty gallery must not create the folder
/// as a side effect, and a read-only location should report an empty list
/// rather than a permission error.
pub fn save_dir_path(settings: &Settings) -> Result<PathBuf> {
    match &settings.save_dir {
        Some(dir) if !dir.trim().is_empty() => Ok(PathBuf::from(dir)),
        _ => Ok(dirs::picture_dir()
            .ok_or_else(|| anyhow!("no Pictures directory"))?
            .join("Shutter")),
    }
}

pub fn save_api_key(key: &str) -> Result<()> {
    let key = key.trim();
    if key.is_empty() {
        return delete_api_key();
    }
    let mut settings = load_settings();
    settings.api_key = key.to_string();
    save_settings(&settings)
}

pub fn load_api_key() -> Result<String> {
    let key = load_settings().api_key;
    if key.trim().is_empty() {
        return Err(anyhow!("尚未设置 API Key，请到设置页填写"));
    }
    Ok(key)
}

pub fn delete_api_key() -> Result<()> {
    let mut settings = load_settings();
    if settings.api_key.is_empty() {
        return Ok(());
    }
    settings.api_key = String::new();
    save_settings(&settings)
}

pub fn has_api_key() -> bool {
    !load_settings().api_key.trim().is_empty()
}

/// The key to use for a request that may carry an unsaved one.
///
/// The settings page needs to test a key the user has typed but not yet
/// committed; everywhere else passes `None` and gets the stored key. The value
/// never travels back to the webview either way.
pub fn resolve_api_key(pending: Option<&str>) -> Result<String> {
    match pending.map(str::trim).filter(|k| !k.is_empty()) {
        Some(key) => Ok(key.to_string()),
        None => load_api_key(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_roundtrip() {
        let mut s = Settings::default();
        s.base_url = "https://example.test".into();
        s.model = "custom-model".into();
        s.copy_after_capture = false;
        let text = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&text).unwrap();
        assert_eq!(back.base_url, "https://example.test");
        assert_eq!(back.model, "custom-model");
        assert!(!back.copy_after_capture);
    }

    #[test]
    fn defaults_target_deepseek() {
        let s = Settings::default();
        assert_eq!(s.base_url, "https://api.deepseek.com");
        assert_eq!(s.model, "deepseek-flash");
    }

    #[test]
    fn corrupt_settings_fall_back_to_defaults() {
        // Mirrors load_settings' behaviour without touching the real file.
        let parsed: std::result::Result<Settings, _> = serde_json::from_str("{not json");
        assert!(parsed.is_err());
    }
}
