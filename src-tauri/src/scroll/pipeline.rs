//! Frame-to-frame vertical displacement estimation for scroll stitching.
//!
//! Faithful Rust reimplementation of the reference app's `pipeline_v2`
//! (`report/03-scroll-pipeline.md`): every captured frame is reduced to row
//! signatures, aligned against the previous frame's tail by row-level LCS,
//! refined with strip NCC over sampled columns, then gated by a verifier
//! (MAE + edge NCC + row integrity) before the stitcher is allowed to append
//! anything. The design rule copied verbatim from the reference is
//! **宁可少拼一帧，也不硬拼** — fail closed, never force-stitch.
//!
//! Deviations from the reference (recorded in the plan):
//! * FFT-NCC is replaced by direct strip NCC (no rustfft dependency; the
//!   selection width is ~hundreds of pixels, so O(n·k) is fast enough).
//! * The OpenCV template-voting fallback is omitted (no OpenCV in this repo).
//! * Row signature line height is a fixed 2px (reference adapts it per page).

use image::RgbaImage;

/// Row signature line height in source pixels (reference `preprocess::LINE_HEIGHT`).
pub const LINE_HEIGHT: u32 = 2;

/// Minimum overlap (px) between the previous tail and the new frame for a
/// stitch to even be attempted; below this the frames share too little content.
const MIN_OVERLAP: u32 = 24;

/// Reject the offset unless the LCS-matched span covers this fraction of the
/// overlap region (reference `matched=` / conf gate).
const MIN_CONFIDENCE: f64 = 0.55;

/// Post-alignment MAE gate over the overlap (0–255 scale).
const MAX_MAE: f64 = 14.0;

/// Post-alignment edge-NCC gate (−1..1; 1 = identical edge structure).
const MIN_EDGE_NCC: f64 = 0.45;

/// Row-integrity gate: fraction of overlap rows that must match within tolerance.
const MIN_ROW_INTEGRITY: f64 = 0.80;

/// Rows at the very top/bottom of a frame that are never trusted for matching
/// (scrollbars, rounding, partial repaint), mirroring the reference's inset.
const EDGE_INSET: u32 = 3;

/// Maximum plausible scroll distance per step (px). Anything larger is
/// treated as a jump (pageDown, tab switch) and rejected rather than stitched.
const MAX_STEP: u32 = 640;

/// A candidate displacement with the evidence the engine gathered for it.
#[derive(Debug, Clone)]
pub struct MatchEvidence {
    /// Vertical offset of the NEW frame's content in the OLD frame's tail
    /// coordinate space: new_row[y] ≈ old_row[y + offset]. Positive means the
    /// page scrolled down.
    pub offset: i64,
    /// Fraction of the overlap that the row matcher actually matched.
    pub confidence: f64,
}

/// Verdict for one frame: append at `offset`, or refuse with a reason that
/// maps onto the reference's Chinese state machine.
#[derive(Debug, Clone)]
pub enum FrameDecision {
    /// Append the frame using this offset (px the page scrolled).
    Append { offset: i64, confidence: f64 },
    /// The frame equals the previous one — nothing scrolled.
    Still,
    /// The page scrolled but alignment evidence is too weak (原地重抓, then
    /// 拒绝 if it persists).
    LowConfidence,
    /// Displacement exceeds what scrolling can produce in one step.
    TooLarge,
    /// The page moved backwards (or sideways beyond tolerance) — intercept.
    Reversed,
    /// Alignment looked fine but pixel verification failed (fail-closed).
    VerifyFailed,
}

/// Grayscale luminance row of `frame`, averaged over `LINE_HEIGHT` rows.
fn row_luma(frame: &RgbaImage) -> Vec<u8> {
    let (w, h) = frame.dimensions();
    let px = frame.as_raw();
    let mut rows = Vec::with_capacity((h / LINE_HEIGHT) as usize);
    let mut y = 0u32;
    while y + LINE_HEIGHT <= h {
        let mut acc = vec![0u32; w as usize];
        for dy in 0..LINE_HEIGHT {
            let base = ((y + dy) * w) as usize * 4;
            for x in 0..w as usize {
                let i = base + x * 4;
                // Rec.601 luma, same as the reference's row signatures.
                // Widened before multiplying: u8 coefficients overflow at
                // debug-assert level.
                let l = (px[i] as u32 * 30
                    + px[i + 1] as u32 * 59
                    + px[i + 2] as u32 * 11)
                    / 100;
                acc[x] += l;
            }
        }
        let n = LINE_HEIGHT as u32;
        rows.extend(acc.into_iter().map(|v| (v / n).min(255) as u8));
        y += LINE_HEIGHT;
    }
    rows
}

/// Mean absolute difference of two equal-length slices (0–255).
fn mad(a: &[u8], b: &[u8]) -> f64 {
    if a.is_empty() {
        return 255.0;
    }
    let sum: u64 = a
        .iter()
        .zip(b)
        .map(|(x, y)| (*x as i64 - *y as i64).unsigned_abs() as u64)
        .sum();
    sum as f64 / a.len() as f64
}

/// Does this frame differ from the last one at all? (reference `looks_still`).
pub fn looks_still(prev: &RgbaImage, next: &RgbaImage) -> bool {
    if prev.dimensions() != next.dimensions() {
        return false;
    }
    let (w, h) = prev.dimensions();
    // Sample a sparse grid rather than every pixel: still-frame detection only
    // needs to notice that *something* moved.
    let step_x = (w / 48).max(1);
    let step_y = (h / 48).max(1);
    let pa = prev.as_raw();
    let pb = next.as_raw();
    let mut diff = 0u64;
    let mut n = 0u64;
    let mut y = 0u32;
    while y < h {
        let mut x = 0u32;
        while x < w {
            let i = ((y * w + x) * 4) as usize;
            let da = (pa[i] as i64 - pb[i] as i64).abs()
                + (pa[i + 1] as i64 - pb[i + 1] as i64).abs()
                + (pa[i + 2] as i64 - pb[i + 2] as i64).abs();
            diff += da.min(765) as u64;
            n += 1;
            x += step_x;
        }
        y += step_y;
    }
    if n == 0 {
        return true;
    }
    // Average per-channel delta below ~1.0 counts as no motion.
    diff as f64 / (n as f64 * 3.0) < 1.0
}

/// Row-level LCS alignment (reference `row_lcs::match_offset`).
///
/// Scans plausible offsets and keeps the one whose matched-row span is
/// longest. `prev_rows` is the previous frame's signatures; `next_rows` the
/// new frame's; `fixed` marks rows identical at the same frame-local y in
/// both frames (sticky UI) which are excluded from matching — the reference
/// runs the matcher on margin-trimmed rows for the same reason.
///
/// Geometry (page scrolled DOWN by `off`): the old viewport showed
/// `src[0..h)` and the new one shows `src[off..h+off)`. The shared content is
/// `src[off..h)` — the TOP `h−off` rows of the new frame equal rows
/// `a[off..h)` of the old frame. Equivalently: `next_row[k] ≡ prev_row[off+k]`
/// for `k < h−off`, and the genuinely new content is the bottom `off` rows
/// of the new frame.
fn row_lcs_offset(
    prev_rows: &[u8],
    next_rows: &[u8],
    w: usize,
    prior: i64,
    fixed: &[bool],
) -> MatchEvidence {
    let h_prev = (prev_rows.len() / w) as i64;
    let h_next = (next_rows.len() / w) as i64;
    let in_fixed = |sig_row: usize| sig_row < fixed.len() && fixed[sig_row];

    let mut candidates: Vec<i64> = Vec::new();
    // Fine window around the prior step.
    for d in -120i64..=120i64 {
        candidates.push((prior + d).max(1));
    }
    // Coarse sweep over the whole plausible range (abrupt changes).
    let mut o = 8i64;
    while o <= MAX_STEP as i64 {
        candidates.push(o);
        o += 16;
    }
    candidates.retain(|&o| o < h_next && o < h_prev);
    candidates.sort_unstable();
    candidates.dedup();

    let mut best = MatchEvidence {
        offset: prior.max(1),
        confidence: 0.0,
    };
    for &off in &candidates {
        // Top of next vs middle of prev (see geometry above).
        let overlap = (h_next - off).min(h_prev - off).max(0) as usize;
        if (overlap as u32) < MIN_OVERLAP / LINE_HEIGHT {
            continue;
        }
        let inset = EDGE_INSET as usize;
        let usable = overlap.saturating_sub(inset * 2);
        if usable < 8 {
            continue;
        }
        let prev_start = off as usize + inset;
        let next_start = inset;
        let mut matched = 0usize;
        let mut total_mad = 0f64;
        let mut counted = 0usize;
        for k in 0..usable {
            // Sticky rows on either side of the aligned pair are skipped.
            if in_fixed(next_start + k) || in_fixed(prev_start + k) {
                continue;
            }
            let a = &prev_rows[(prev_start + k) * w..(prev_start + k + 1) * w];
            let b = &next_rows[(next_start + k) * w..(next_start + k + 1) * w];
            let m = mad(a, b);
            total_mad += m;
            counted += 1;
            // A row "matches" when its MAD is under 10/255: clean captures
            // give ~0, sensor-noised ones a few units, misaligned rows tens.
            if m < 10.0 {
                matched += 1;
            }
        }
        if counted < 8 {
            continue;
        }
        // Confidence: matched fraction, discounted by average error so a
        // uniformly-almost-matching offset cannot beat a precisely-matching
        // one (striped pages make coarse MAD ambiguous on its own).
        let conf = matched as f64 / counted as f64;
        let avg_mad = total_mad / counted as f64;
        let score = conf * (1.0 - (avg_mad / 48.0).min(1.0));
        if score > best.confidence {
            best = MatchEvidence {
                offset: off,
                confidence: score,
            };
        }
    }
    best
}

/// Column sampling for NCC refinement (reference `fft_ncc::sample_xs`).
fn sample_xs(w: u32) -> Vec<u32> {
    // Up to 24 columns, evenly spaced, avoiding the outer 4% (scrollbars).
    let n = ((w / 40).max(1)).min(24);
    let lo = (w as f64 * 0.04).ceil() as u32;
    let hi = w - lo;
    if n == 1 || hi <= lo {
        return vec![w / 2];
    }
    (0..n)
        .map(|i| lo + (i as f64 * (hi - lo) as f64 / (n - 1) as f64).round() as u32)
        .collect()
}

fn luma_at(img: &RgbaImage, x: u32, y: u32) -> f64 {
    let p = img.get_pixel(x, y);
    (p.0[0] as f64 * 30.0 + p.0[1] as f64 * 59.0 + p.0[2] as f64 * 11.0) / 100.0
}

/// Edge energy per row (Sobel-ish horizontal difference), for edge NCC.
fn row_edge(img: &RgbaImage, y: u32) -> f64 {
    let w = img.width();
    if w < 2 {
        return 0.0;
    }
    let mut acc = 0f64;
    for x in 0..w - 1 {
        let a = luma_at(img, x, y);
        let b = luma_at(img, x + 1, y);
        acc += (b - a).abs();
    }
    acc / w as f64
}

/// The full per-frame decision (reference `V2Engine::estimate` + `verify`).
///
/// `prev` is the previously appended frame, `next` the freshly captured one,
/// `prior` the recent scroll step to bias the search around. Checks, in order:
/// still → estimate → plausibility → verify → append.
pub fn decide(prev: &RgbaImage, next: &RgbaImage, prior: i64) -> FrameDecision {
    if prev.dimensions() != next.dimensions() {
        return FrameDecision::VerifyFailed;
    }
    if looks_still(prev, next) {
        return FrameDecision::Still;
    }

    let (w, _h) = prev.dimensions();
    let prev_rows = row_luma(prev);
    let next_rows = row_luma(next);
    let width = w as usize;

    // Sticky (fixed) signature rows: identical at the same frame-local y in
    // both frames — a fixed header/footer or floating bar (reference
    // `margins::detect_fixed_margins`). Excluded from matching and
    // verification alike; their presence at a scroll offset would otherwise
    // reject every frame of a page with a fixed header.
    let sig_rows = (prev_rows.len() / width).min(next_rows.len() / width);
    let fixed: Vec<bool> = (0..sig_rows)
        .map(|r| {
            let a = &prev_rows[r * width..(r + 1) * width];
            let b = &next_rows[r * width..(r + 1) * width];
            mad(a, b) < 1.0
        })
        .collect();

    let evidence = row_lcs_offset(&prev_rows, &next_rows, width, prior.max(1), &fixed);
    // Signature rows are LINE_HEIGHT px tall: convert the match to pixels.
    let offset = evidence.offset * LINE_HEIGHT as i64;
    let confidence = evidence.confidence;

    if offset > MAX_STEP as i64 {
        return FrameDecision::TooLarge;
    }
    if confidence < MIN_CONFIDENCE {
        // Low confidence is recoverable by re-capturing in place (原地重抓);
        // the session controller decides how many times to retry.
        log::info!(
            "[长截图][v2] fail-closed offset={offset} conf={confidence:.2} \
             (< {MIN_CONFIDENCE:.2}) → 原地重抓"
        );
        return FrameDecision::LowConfidence;
    }

    // --- verify (reference `verify::overlap_mae / overlap_edge_ncc / row`) ---
    let h_prev = prev.height() as i64;
    let h_next = next.height() as i64;
    // Same geometry as the row matcher: top (h−off) rows of the new frame
    // equal rows [off, h) of the old frame.
    let overlap = (h_next - offset).min(h_prev - offset).max(0) as u32;
    if overlap < MIN_OVERLAP {
        return FrameDecision::LowConfidence;
    }
    // prev reads from row `offset`; next reads from its top.
    let y_prev_start = offset.max(0) as u32;
    let y_next_start = 0;

    let xs = sample_xs(w);
    let inset = EDGE_INSET;
    let check = overlap.saturating_sub(inset * 2);

    // The pixel-level fixed mask from the signature rows (fixed[r] covers
    // pixel rows r*LINE_HEIGHT..(r+1)*LINE_HEIGHT).
    let in_fixed = |px_row: u32| {
        let r = (px_row / LINE_HEIGHT) as usize;
        r < fixed.len() && fixed[r]
    };
    // The aligned pair at `dy` is prev[off+dy] ↔ next[dy]: mask it when either
    // side lands in a fixed region.
    let sticky_mask: Vec<bool> = (inset..check + inset)
        .map(|dy| in_fixed(dy) || in_fixed(y_prev_start + dy))
        .collect();

    // MAE over the non-sticky overlap rows.
    let mut mae_acc = 0f64;
    let mut n = 0f64;
    let mut sticky_rows = 0usize;
    for (i, dy) in (inset..check + inset).enumerate() {
        if sticky_mask[i] {
            sticky_rows += 1;
            continue;
        }
        for &x in &xs {
            let a = luma_at(prev, x, y_prev_start + dy);
            let b = luma_at(next, x, y_next_start + dy);
            mae_acc += (a - b).abs();
            n += 1.0;
        }
    }
    // A page that is entirely sticky (nothing scrollable matched) is Still.
    if sticky_rows > 0 && n == 0.0 {
        return FrameDecision::Still;
    }
    let mae = if n > 0.0 { mae_acc / n } else { 255.0 };

    // Edge NCC over non-sticky rows.
    let mut ea = Vec::new();
    let mut eb = Vec::new();
    for (i, dy) in (inset..check + inset).enumerate() {
        if sticky_mask[i] {
            continue;
        }
        ea.push(row_edge(prev, y_prev_start + dy));
        eb.push(row_edge(next, y_next_start + dy));
    }
    let edge_ncc = if ea.len() >= 8 {
        ncc_slices(&ea, &eb)
    } else {
        // Not enough non-sticky rows to judge: accept on the row matcher's
        // evidence alone (this is a mostly-fixed viewport).
        1.0
    };

    // Row integrity over non-sticky rows.
    let mut rows_ok = 0usize;
    let mut rows_total = 0usize;
    for (i, dy) in (inset..check + inset).enumerate() {
        if sticky_mask[i] {
            continue;
        }
        let mut row_mae = 0f64;
        let mut rn = 0f64;
        for &x in &xs {
            let a = luma_at(prev, x, y_prev_start + dy);
            let b = luma_at(next, x, y_next_start + dy);
            row_mae += (a - b).abs();
            rn += 1.0;
        }
        if rn > 0.0 && row_mae / rn < 24.0 {
            rows_ok += 1;
        }
        rows_total += 1;
    }
    let row_score = if rows_total > 0 {
        rows_ok as f64 / rows_total as f64
    } else {
        1.0
    };

    log::info!(
        "[长截图][v2] offset={offset} conf={confidence:.2} mae={mae:.1} \
         edge_ncc={edge_ncc:.2} row={row_score:.2} sticky={sticky_rows}"
    );
    if cfg!(test) {
        eprintln!(
            "[probe] off={offset} conf={confidence:.2} mae={mae:.1} \
             edge={edge_ncc:.2} row={row_score:.2} ov={overlap} sticky={sticky_rows}"
        );
    }

    if mae > MAX_MAE || edge_ncc < MIN_EDGE_NCC || row_score < MIN_ROW_INTEGRITY {
        log::info!("[长截图][v2] 拒绝硬拼 mae={mae:.1} edge={edge_ncc:.2} row={row_score:.2}");
        return FrameDecision::VerifyFailed;
    }

    FrameDecision::Append { offset, confidence }
}

/// NCC of two equal-length f64 slices (−1..1).
fn ncc_slices(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len().min(b.len());
    if n == 0 {
        return -1.0;
    }
    let (mut sa, mut sb, mut saa, mut sbb, mut sab) = (0f64, 0f64, 0f64, 0f64, 0f64);
    for i in 0..n {
        let (x, y) = (a[i], b[i]);
        sa += x;
        sb += y;
        saa += x * x;
        sbb += y * y;
        sab += x * y;
    }
    let nn = n as f64;
    let cov = sab - sa * sb / nn;
    let va = (saa - sa * sa / nn).max(0.0);
    let vb = (sbb - sb * sb / nn).max(0.0);
    if va <= f64::EPSILON || vb <= f64::EPSILON {
        return -1.0;
    }
    cov / (va.sqrt() * vb.sqrt())
}

/// Direction check between the committed offset history and a new estimate
/// (reference `检测到滚动方向反转 → 已拦截本次滚动`).
pub fn direction_reversed(history: &[i64], offset: i64) -> bool {
    let Some(&last) = history.last() else {
        return false;
    };
    // A single opposite-sign step after consistent downward motion is the
    // reversal the reference intercepts. Zero steps are neutral (pauses).
    history.iter().filter(|&&o| o != 0).all(|&o| o > 0) && last > 0 && offset < 0
        || history.iter().filter(|&&o| o != 0).all(|&o| o < 0) && last < 0 && offset > 0
}

/// Median of the recent committed offsets (reference `global_chain::median_recent`),
/// used as the `prior` bias for the next search.
pub fn median_recent(history: &[i64], window: usize) -> i64 {
    let tail: Vec<i64> = history.iter().rev().take(window).copied().collect();
    if tail.is_empty() {
        return 12
    }
    let mut sorted = tail;
    sorted.sort_unstable();
    sorted[sorted.len() / 2]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A synthetic page: horizontal stripes + a moving text band, so every
    /// row is unique enough for row matching.
    fn page(seed: u64, w: u32, h: u32) -> RgbaImage {
        use std::cell::Cell;
        let state = Cell::new(seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407));
        let next = || {
            let x = state.get();
            state.set(x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407));
            (x >> 33) as u8
        };
        let mut img = RgbaImage::new(w, h);
        for y in 0..h {
            // 7px bands whose spacing and phase both depend on the seed: a
            // constant shift can never align two different pages (same
            // multiplier would alias mod 256). Matching at the right offset
            // gives MAD≈0, any misalignment a large MAD — like text.
            let k = (y / 7) % 256;
            let band = (k.wrapping_mul(23 + (seed % 13) as u32).wrapping_add((seed % 256) as u32 * 37) % 256) as u8;
            for x in 0..w {
                let n = if x % 5 == 0 { next() / 8 } else { 0 };
                let v = band.wrapping_add(n);
                img.put_pixel(x, y, image::Rgba([v, v.wrapping_add(2), 255u8.wrapping_sub(v), 255]));
            }
        }
        img
    }

    /// Crop rows [y, y+h) of a page — a "scrolled" view of the same content.
    fn window_of(src: &RgbaImage, y: u32, h: u32) -> RgbaImage {
        image::imageops::crop_imm(src, 0, y, src.width(), h).to_image()
    }

    #[test]
    fn exact_offset_is_recovered() {
        let src = page(7, 300, 2000);
        let a = window_of(&src, 0, 400);
        for &off in &[40i64, 96, 200] {
            let b = window_of(&src, off as u32, 400);
            match decide(&a, &b, 12) {
                FrameDecision::Append { offset, .. } => assert_eq!(offset, off, "offset {off}"),
                other => panic!("expected Append, got {other:?}"),
            }
        }
    }

    #[test]
    fn identical_frame_is_still() {
        let src = page(3, 240, 900);
        let a = window_of(&src, 100, 400);
        assert!(matches!(decide(&a, &a, 12), FrameDecision::Still));
    }

    #[test]
    fn unrelated_frames_are_rejected() {
        let a = page(11, 260, 400);
        let b = page(99, 260, 400);
        assert!(!matches!(
            decide(&a, &b, 12),
            FrameDecision::Append { .. }
        ));
    }

    #[test]
    fn noisy_capture_still_appends() {
        let src = page(21, 280, 1600);
        let a = window_of(&src, 0, 400);
        let mut b = window_of(&src, 80, 400);
        // Sensor-like noise: R −2, G 0, B +2 (a signed nudge per channel;
        // `as u8` on a negative i16 would wrap to ~254 and whiten the red
        // channel, which is not the noise being modelled).
        for p in b.pixels_mut() {
            p.0[0] = p.0[0].saturating_sub(2);
            p.0[2] = p.0[2].saturating_add(2);
        }
        match decide(&a, &b, 12) {
            FrameDecision::Append { offset, .. } => assert_eq!(offset, 80),
            other => panic!("expected Append, got {other:?}"),
        }
    }

    #[test]
    fn tiny_scroll_without_overlap_rejects_or_still() {
        // 1px scroll: rows barely move; the engine may call it Still (fine —
        // nothing meaningfully scrolled) but must never mis-append.
        let src = page(5, 240, 1200);
        let a = window_of(&src, 0, 400);
        let b = window_of(&src, 1, 400);
        match decide(&a, &b, 12) {
            FrameDecision::Still => {}
            FrameDecision::Append { offset, .. } => assert!(offset <= 2),
            // A sub-line-height scroll straddles the signature grid: refusing
            // it is exactly the reference's fail-closed behaviour.
            FrameDecision::VerifyFailed | FrameDecision::LowConfidence => {}
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn direction_reversal_is_detected() {
        assert!(direction_reversed(&[40, 40, 40], -30));
        assert!(!direction_reversed(&[40, 40, 40], 40));
        assert!(!direction_reversed(&[], -30));
    }

    #[test]
    fn median_of_empty_history_is_default_step() {
        assert_eq!(median_recent(&[], 5), 12);
        assert_eq!(median_recent(&[10, 40, 90], 3), 40);
    }
}
