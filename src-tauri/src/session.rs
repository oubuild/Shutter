//! In-memory capture sessions and crop handles.
//!
//! Frames are kept at full physical resolution so the final crop never comes
//! from a downscaled preview. Everything here is transient: a new capture
//! supersedes the previous one, and crop handles are dropped once the AI layer
//! has consumed them.

use crate::capture::Display;
use anyhow::{anyhow, Result};
use image::RgbaImage;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub struct Session {
    pub id: String,
    pub displays: Vec<Display>,
    /// Physical-resolution frame per monitor id.
    frames: HashMap<u32, RgbaImage>,
}

impl Session {
    pub fn frame(&self, monitor_id: u32) -> Option<&RgbaImage> {
        self.frames.get(&monitor_id)
    }

    pub fn display(&self, monitor_id: u32) -> Option<&Display> {
        self.displays.iter().find(|d| d.info.id == monitor_id)
    }
}

#[derive(Default)]
pub struct Store {
    /// Only the newest session is kept: the overlay always operates on it.
    current: Mutex<Option<Arc<Session>>>,
    /// PNG bytes for finished crops, keyed by crop id.
    crops: Mutex<HashMap<String, Vec<u8>>>,
}

/// A crop plus the dimensions the pin window should use.
pub struct CropInfo {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

impl Store {
    pub fn new() -> Self {
        Self::default()
    }

    /// Capture every display and make this the active session.
    pub fn begin(&self, displays: Vec<Display>) -> Result<Arc<Session>> {
        let mut frames = HashMap::with_capacity(displays.len());
        for display in &displays {
            frames.insert(display.info.id, display.capture()?);
        }
        let session = Arc::new(Session {
            id: uuid::Uuid::new_v4().to_string(),
            displays,
            frames,
        });
        *self.current.lock().unwrap() = Some(Arc::clone(&session));
        // A new capture invalidates prior crops by construction.
        self.crops.lock().unwrap().clear();
        Ok(session)
    }

    pub fn current(&self) -> Option<Arc<Session>> {
        self.current.lock().unwrap().clone()
    }

    pub fn current_id(&self) -> Option<String> {
        self.current().map(|s| s.id.clone())
    }

    pub fn clear(&self) {
        *self.current.lock().unwrap() = None;
        self.crops.lock().unwrap().clear();
    }

    pub fn put_crop(&self, png: Vec<u8>) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.crops.lock().unwrap().insert(id.clone(), png);
        id
    }

    pub fn crop(&self, id: &str) -> Result<Vec<u8>> {
        self.crops
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("crop {id} not found; take a new screenshot"))
    }

    /// Crop bytes plus pixel size, so window chrome can match the image.
    pub fn crop_info(&self, id: &str) -> Result<CropInfo> {
        let png = self.crop(id)?;
        let decoded = image::load_from_memory(&png).map_err(|e| anyhow!("decode crop: {e}"))?;
        let (width, height) = (decoded.width(), decoded.height());
        Ok(CropInfo { png, width, height })
    }
}

impl Store {
    /// Write a monitor's frame to disk so the overlay can display the frozen
    /// desktop through the asset protocol (a data URL would be far too big).
    pub fn write_frame_png(&self, monitor_id: u32, dir: &std::path::Path) -> Result<std::path::PathBuf> {
        let session = self
            .current()
            .ok_or_else(|| anyhow!("no active capture session"))?;
        let frame = session
            .frame(monitor_id)
            .ok_or_else(|| anyhow!("monitor {monitor_id} is not part of this session"))?;
        std::fs::create_dir_all(dir)?;
        let path = dir.join(format!("frame-{}-{monitor_id}.png", session.id));
        let mut buf = std::io::Cursor::new(Vec::new());
        frame.write_to(&mut buf, image::ImageFormat::Png)?;
        std::fs::write(&path, buf.into_inner())?;
        Ok(path)
    }
}

impl Store {
    /// Drop frame files from previous sessions so the cache does not grow.
    pub fn prune_frames(dir: &std::path::Path, keep: &str) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("frame-") && !name.contains(keep) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}
