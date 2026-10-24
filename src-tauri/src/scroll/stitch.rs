//! Incremental stitching of accepted frames into the accumulated long image.
//!
//! Mirrors the reference `image_stitcher` + `compute_top`: frames are appended
//! onto a growing buffer at the estimated (and verifier-gated) offset, with
//! sticky-region (fixed header/footer) removal (reference
//! `margins::detect_fixed_margins` + `stitch_incremental_with_fixed_margins`).

use crate::scroll::pipeline::FrameDecision;
use image::{imageops, RgbaImage};

/// A run of rows that is byte-identical between consecutive frames near the
/// same y position across ≥ this many frames is treated as a fixed bar.
const STICKY_MIN_FRAMES: u32 = 3;

/// Max height of the header/footer band considered for sticky detection.
const STICKY_MAX_BAND: u32 = 220;

/// The growing stitched image plus everything needed to append safely.
pub struct Stitcher {
    /// The accumulated image (width = selection width, grows downward).
    image: RgbaImage,
    /// The last frame as appended (post dedup), for the next alignment.
    last_frame: RgbaImage,
    /// Offsets actually committed (for seam bias + direction checks).
    history: Vec<i64>,
    /// Consecutive frames' leading-equal-row depths, for sticky detection.
    candidate_depths: Vec<u32>,
    /// Rows at the top confirmed to be a fixed (sticky) region.
    sticky_top: u32,
    /// Diagnostics counter.
    appended: u32,
}

fn row_hash(img: &RgbaImage, y: u32) -> u64 {
    let w = img.width() as usize;
    let mut h: u64 = 1469598103934665603;
    for x in 0..w {
        let p = img.get_pixel(x as u32, y);
        for c in 0..3 {
            h ^= p.0[c] as u64;
            h = h.wrapping_mul(1099511628211);
        }
    }
    h
}

impl Stitcher {
    /// First frame becomes the base of the accumulated image.
    pub fn new(first: RgbaImage) -> Self {
        Self {
            image: first.clone(),
            last_frame: first,
            history: Vec::new(),
            candidate_depths: Vec::new(),
            sticky_top: 0,
            appended: 1,
        }
    }

    pub fn height(&self) -> u32 {
        self.image.height()
    }

    pub fn width(&self) -> u32 {
        self.image.width()
    }

    pub fn history(&self) -> &[i64] {
        &self.history
    }

    pub fn appended_frames(&self) -> u32 {
        self.appended
    }

    /// Rows of `img` [y0, y1) as an owned buffer.
    fn rows(img: &RgbaImage, y0: u32, y1: u32) -> RgbaImage {
        imageops::crop_imm(img, 0, y0, img.width(), y1 - y0).to_image()
    }

    /// Detect a fixed top band: rows that are identical at the SAME
    /// frame-local y across `STICKY_MIN_FRAMES` consecutive frames
    /// (reference `detect_fixed_margins` / `MAC_FIXED_TILE_STREAKS`). A
    /// scrolling page never repeats a row at the same y; a fixed header does.
    fn update_sticky_top(&mut self, frame: &RgbaImage) {
        // Depth of the leading run of rows equal to the previous frame's rows
        // at the same y.
        let limit = frame.height().min(STICKY_MAX_BAND);
        let mut depth = 0u32;
        while depth < limit && row_hash(frame, depth) == row_hash(&self.last_frame, depth) {
            depth += 1;
        }
        // Track the streak: a candidate becomes confirmed once it repeats for
        // STICKY_MIN_FRAMES frames (2 in the pair + current).
        if depth >= 24 {
            self.candidate_depths.push(depth);
        } else {
            self.candidate_depths.clear();
        }
        if self.candidate_depths.len() >= STICKY_MIN_FRAMES as usize {
            let confirmed = *self.candidate_depths.iter().min().unwrap();
            if confirmed > self.sticky_top {
                self.sticky_top = confirmed;
                log::info!("[长截图] 固定栏 header={}px", self.sticky_top);
            }
        }
    }

    /// Append a frame at the estimated offset. Returns the rows actually added.
    ///
    /// Geometry (same as the pipeline's): the frame's top `fh − offset` rows
    /// duplicate content already accumulated; only its bottom `offset` rows
    /// are new. The split sits at the verifier-gated offset; no seam search is
    /// re-run here (the reference's `seam::overlap_seam_cost` only guards
    /// against ±1px rounding, which the verifier already covers).
    pub fn append(&mut self, frame: RgbaImage, decision: &FrameDecision, offset: i64) -> u32 {
        let FrameDecision::Append { .. } = decision else {
            return 0;
        };
        self.update_sticky_top(&frame);

        let fh = frame.height() as i64;
        // Rows of the frame that re-show existing content.
        let overlap = (fh - offset).max(0);

        // Copy the genuinely new rows below the accumulated image.
        let y_from = overlap.max(0) as u32;
        let add = (fh as u32).saturating_sub(y_from);
        if add == 0 {
            self.last_frame = frame;
            return 0;
        }
        let new_part = Self::rows(&frame, y_from, fh as u32);
        let mut grown = RgbaImage::new(self.image.width(), self.image.height() + add);
        imageops::overlay(&mut grown, &self.image, 0, 0);
        imageops::overlay(&mut grown, &new_part, 0, self.image.height() as i64);
        self.image = grown;
        self.history.push(offset);
        self.appended += 1;
        self.last_frame = frame;
        add
    }

    /// The last appended frame — the alignment target for the next capture.
    pub fn last_frame(&self) -> &RgbaImage {
        &self.last_frame
    }

    /// Strip the detected sticky header from the final image (reference
    /// `stitch_incremental_with_fixed_margins` de-duplicates fixed bars).
    pub fn finish(mut self) -> RgbaImage {
        if self.sticky_top > 0 {
            let h = self.image.height();
            let keep = h.saturating_sub(self.sticky_top);
            if keep > 0 {
                self.image = Self::rows(&self.image, self.sticky_top, h);
                log::info!(
                    "[长截图] 去除固定顶栏 {}px，最终 {}x{}",
                    self.sticky_top,
                    self.image.width(),
                    self.image.height()
                );
            }
        }
        self.image
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(seed: u64, w: u32, h: u32) -> RgbaImage {
        use std::cell::Cell;
        let state =
            Cell::new(seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407));
        let next = || {
            let x = state.get();
            state.set(x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407));
            (x >> 33) as u8
        };
        let mut img = RgbaImage::new(w, h);
        for y in 0..h {
            // Same generator as the pipeline tests: seed-spaced, seed-phased
            // bands so a wrong alignment can never look like a match.
            let k = (y / 7) % 256;
            let band = (k
                .wrapping_mul(23 + (seed % 13) as u32)
                .wrapping_add((seed % 256) as u32 * 37)
                % 256) as u8;
            for x in 0..w {
                let n = if x % 5 == 0 { next() / 8 } else { 0 };
                let v = band.wrapping_add(n);
                img.put_pixel(x, y, image::Rgba([v, v.wrapping_add(2), 255u8.wrapping_sub(v), 255]));
            }
        }
        img
    }

    fn window_of(src: &RgbaImage, y: u32, h: u32) -> RgbaImage {
        imageops::crop_imm(src, 0, y, src.width(), h).to_image()
    }

    #[test]
    fn stitches_three_windows() {
        let src = page(31, 200, 1400);
        let mut stitcher = Stitcher::new(window_of(&src, 0, 300));
        let mut total = 300u32;
        let mut y = 0u32;
        for &off in &[120i64, 90, 150] {
            y += off as u32;
            let frame = window_of(&src, y, 300);
            let decision = crate::scroll::pipeline::decide(stitcher.last_frame(), &frame, 12);
            let FrameDecision::Append { offset, .. } = decision else {
                panic!("expected append, got {decision:?}");
            };
            let added = stitcher.append(frame, &decision, offset);
            total += added;
            assert_eq!(stitcher.height(), total);
        }
        let out = stitcher.finish();
        assert_eq!(out.height(), total);
        // Content check: the stitched image equals the source slice.
        let expect = window_of(&src, 0, total);
        for y in (0..total).step_by(7) {
            for x in (0..200).step_by(11) {
                assert_eq!(out.get_pixel(x, y), expect.get_pixel(x, y), "at {x},{y}");
            }
        }
    }

    #[test]
    fn sticky_header_is_detected_and_stripped() {
        let src = page(41, 200, 1600);
        // Fixed 40px header prepended to every "frame".
        let header = window_of(&src, 0, 40);
        let compose = |y: u32| {
            let body = window_of(&src, 40 + y, 300);
            let mut img = RgbaImage::new(200, 340);
            imageops::overlay(&mut img, &header, 0, 0);
            imageops::overlay(&mut img, &body, 0, 40);
            img
        };
        let mut stitcher = Stitcher::new(compose(0));
        let mut y = 0u32;
        for &off in &[100i64, 110, 90] {
            y += off as u32;
            let frame = compose(y);
            let decision = crate::scroll::pipeline::decide(stitcher.last_frame(), &frame, 12);
            let FrameDecision::Append { offset, .. } = decision else {
                panic!("expected append, got {decision:?}");
            };
            stitcher.append(frame, &decision, offset);
        }
        let out = stitcher.finish();
        // The 40px header should have been detected and removed.
        assert!(out.height() < 340 + 300, "header not stripped: {}", out.height());
    }
}
