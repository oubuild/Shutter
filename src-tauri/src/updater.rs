//! Dual-source app updates: CNB mirror (default, mainland-friendly) with a
//! GitHub fallback, switchable from the About page and persisted in settings.
//!
//! The stock plugin reads static endpoints from tauri.conf.json, but CNB asset
//! URLs embed the release tag, so they cannot serve a "latest" alias. Instead
//! of re-checking against CNB's per-tag manifest, the resolved GitHub `Update`
//! keeps its manifest data (version, notes, signature) and only the download
//! URL is swapped to CNB after a cheap availability probe — the minisign
//! signature in the manifest verifies the artifact bytes no matter which host
//! served them. (Architecture follows t8y2/dbx's updater source switching.)

use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

const GITHUB_LATEST_JSON: &str =
    "https://github.com/oubuild/Shutter/releases/latest/download/latest.json";
const GITHUB_RELEASE_DOWNLOAD_PREFIX: &str =
    "https://github.com/oubuild/Shutter/releases/download/";
const CNB_RELEASE_DOWNLOAD_PREFIX: &str = "https://cnb.cool/ryanuo/shutter/-/releases/download/";

/// How long a manifest check may take before we give up on it.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// How long the CNB availability probe may take.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateSource {
    Cnb,
    Github,
}

impl UpdateSource {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "cnb" => Ok(Self::Cnb),
            "github" => Ok(Self::Github),
            other => Err(format!("未知的更新源「{other}」")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cnb => "cnb",
            Self::Github => "github",
        }
    }
}

/// Answer of `check_app_update`, camelCase for the frontend.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub notes: Option<String>,
}

/// Payload of the `app-update-progress` event.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

/// Build an updater pointed at the GitHub manifest — the single discovery
/// source for both update sources (CNB has no "latest" alias).
async fn discover_update(app: &AppHandle) -> Result<Option<Update>, String> {
    let endpoints = vec![
        Url::parse(GITHUB_LATEST_JSON).map_err(|e| format!("更新地址无效：{e}"))?,
    ];
    let updater = app
        .updater_builder()
        .endpoints(endpoints)
        .map_err(|e| format!("配置更新器失败：{e}"))?
        .build()
        .map_err(|e| format!("创建更新器失败：{e}"))?;
    tokio::time::timeout(CHECK_TIMEOUT, updater.check())
        .await
        .map_err(|_| "检查更新超时，请稍后重试".to_string())?
        .map_err(|e| format!("检查更新失败：{e}"))
}

/// Map a GitHub release asset URL to its CNB mirror twin; `None` for anything
/// that is not one of our GitHub asset URLs.
fn to_cnb_asset_url(github_url: &str) -> Option<Url> {
    let rest = github_url.strip_prefix(GITHUB_RELEASE_DOWNLOAD_PREFIX)?;
    Url::parse(&format!("{CNB_RELEASE_DOWNLOAD_PREFIX}{rest}")).ok()
}

/// Probe whether the CNB mirror already has the asset (release sync can lag
/// behind the GitHub publish). Any probe failure keeps the GitHub URL.
async fn prefer_cnb_download(update: &mut Update) {
    let Some(cnb_url) = to_cnb_asset_url(update.download_url.as_str()) else {
        return;
    };
    match reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
    {
        Ok(client) => {
            if client.head(cnb_url.clone()).send().await.is_ok_and(|r| r.status().is_success()) {
                update.download_url = cnb_url;
            }
        }
        Err(_) => {}
    }
}

async fn resolve_update(app: &AppHandle, source: UpdateSource) -> Result<Option<Update>, String> {
    let mut update = discover_update(app).await?;
    if let (UpdateSource::Cnb, Some(update)) = (source, &mut update) {
        prefer_cnb_download(update).await;
    }
    Ok(update)
}

#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    source: String,
) -> Result<Option<UpdateInfo>, String> {
    let source = UpdateSource::parse(&source)?;
    match resolve_update(&app, source).await? {
        None => Ok(None),
        Some(update) => Ok(Some(UpdateInfo {
            current_version: update.current_version.clone(),
            latest_version: update.version.clone(),
            notes: update.body.clone(),
        })),
    }
}

#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    source: String,
    expected_version: String,
) -> Result<(), String> {
    let source = UpdateSource::parse(&source)?;
    let Some(update) = resolve_update(&app, source).await? else {
        return Err("没有可用更新".into());
    };
    // A release published between the user's check and this install must not
    // be silently replaced under them; the frontend re-checks on this signal.
    if update.version != expected_version {
        return Err("VERSION_CHANGED".into());
    }
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                let _ = app.emit(
                    "app-update-progress",
                    UpdateProgress {
                        downloaded,
                        total,
                    },
                );
            },
            || {},
        )
        .await
        .map_err(|e| format!("下载或安装失败：{e}"))?;
    // On Windows the NSIS installer takes over as the process exits; on
    // macOS/Linux the bundle is already replaced and the frontend relaunches.
    Ok(())
}
