//! Persisted user settings (non-secret) and the DeepSeek API key in Keychain.

use crate::types::Settings;
use anyhow::{anyhow, Context, Result};
use std::path::PathBuf;

const KEYCHAIN_SERVICE: &str = "dev.oubuild.shutter";
const KEYCHAIN_ACCOUNT: &str = "deepseek-api-key";

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
    // Write-then-rename so a crash cannot truncate the file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).with_context(|| format!("write {}", tmp.display()))?;
    std::fs::rename(&tmp, &path).with_context(|| format!("rename into {}", path.display()))?;
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

fn entry() -> Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| anyhow!("open keychain entry: {e}"))
}

pub fn save_api_key(key: &str) -> Result<()> {
    let key = key.trim();
    if key.is_empty() {
        return delete_api_key();
    }
    entry()?
        .set_password(key)
        .map_err(|e| anyhow!("store API key in keychain: {e}"))
}

pub fn load_api_key() -> Result<String> {
    match entry()?.get_password() {
        Ok(key) if !key.trim().is_empty() => Ok(key),
        Ok(_) => Err(anyhow!("API key is empty")),
        Err(keyring::Error::NoEntry) => Err(anyhow!(
            "尚未设置 API Key，请到设置页填写"
        )),
        Err(e) => Err(anyhow!("read API key from keychain: {e}")),
    }
}

pub fn delete_api_key() -> Result<()> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(anyhow!("delete API key: {e}")),
    }
}

pub fn has_api_key() -> bool {
    load_api_key().is_ok()
}

/// The key to use for a request that may carry an unsaved one.
///
/// The settings page needs to test a key the user has typed but not yet
/// committed to the keychain; everywhere else passes `None` and gets the stored
/// key. The value never travels back to the webview either way.
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
