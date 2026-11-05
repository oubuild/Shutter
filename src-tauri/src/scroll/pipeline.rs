//! Frame-to-frame vertical displacement estimation for scroll stitching.
//!
//! Faithful Rust reimplementation of the reference app's `pipeline_v2`
//! (`report/03-scroll-pipeline.md`): every captured frame is reduced to row
//! signatures, aligned against the previous frame's tail by row-level LCS,
//! then — like the reference's multi-source engine — rescued by a full-range
//! column FFT-NCC estimator when the row matcher's evidence is too weak, and
//! refined to pixel granularity before being gated by a verifier
//! (MAE + edge NCC + row integrity + SSIM) that must pass before the stitcher
//! is allowed to append anything. The design rule copied verbatim from the
//! reference is **宁可少拼一帧，也不硬拼** — fail closed, never force-stitch.
//!
//! Deviations from the reference (recorded in the plan):
//! * The OpenCV template-voting fallback is omitted (no OpenCV in this repo);
//!   the FFT-NCC estimator covers its "second opinion" role.
//! * Row signature line height adapts per session between 2px and 4px
//!   (reference `preprocess::set_line_height` adapts over a wider range).

use crate::scroll::stitch::Stitcher;
use image::RgbaImage;

/// Default row signature line height in source pixels (reference
/// `preprocess::LINE_HEIGHT`); smooth pages get 4 via `choose_line_height`.
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

/// Post-alignment SSIM gate (0..1; structural similarity over the overlap).
/// Complements MAE: catches small-but-structured differences (reflow, AA
/// shifts) that per-sample error averaging dilutes away.
const MIN_SSIM: f64 = 0.50;

/// Rows at the very top/bottom of a frame that are never trusted for matching
/// (scrollbars, rounding, partial repaint), mirroring the reference's inset.
const EDGE_INSET: u32 = 3;

/// Commit-time seam sweep radius (reference `seam` stage). The row matcher's
/// grid can alias on smooth pages — a gradient matches at many offsets, so the
/// LCS candidate can sit ~10px off the true displacement while every verifier
/// gate still passes, and committing it tears the image at the join (replayed
/// on real rendered frames: a 240px step accepted as 230px with mae=6.4).
/// Sampling the same MAE over ±SEAM_RADIUS at commit time recovers the exact
/// offset before the append is allowed.
const SEAM_RADIUS: i64 = 12;

/// An accepted alignment this clean is never re-swept (the reference's
/// steady-state mae runs 0.0–0.7 on 20px steps): the seam stage only pays for
/// itself when the verifier passed with visible residual error.
const SEAM_CLEAN_MAE: f64 = 1.5;

/// A seam candidate must beat the verified estimate by this MAE margin, so
/// sensor noise on a genuinely correct offset cannot dither the commit.
const SEAM_MARGIN: f64 = 1.5;

/// Maximum plausible scroll distance per step (px). Anything larger is
/// treated as a jump (pageDown, tab switch) and rejected rather than stitched.
pub(crate) const MAX_STEP: u32 = 640;

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

/// Grayscale luminance row of `frame`, averaged over `line_height` rows.
fn row_luma(frame: &RgbaImage, line_height: u32) -> Vec<u8> {
    let (w, h) = frame.dimensions();
    let px = frame.as_raw();
    let mut rows = Vec::with_capacity((h / line_height) as usize);
    let mut y = 0u32;
    while y + line_height <= h {
        let mut acc = vec![0u32; w as usize];
        for dy in 0..line_height {
            let base = ((y + dy) * w) as usize * 4;
            for x in 0..w as usize {
                let i = base + x * 4;
                // Rec.601 luma, same as the reference's row signatures.
                // Widened before multiplying: u8 coefficients overflow at
                // debug-assert level.
                let l = (px[i] as u32 * 30 + px[i + 1] as u32 * 59 + px[i + 2] as u32 * 11) / 100;
                acc[x] += l;
            }
        }
        rows.extend(acc.into_iter().map(|v| (v / line_height).min(255) as u8));
        y += line_height;
    }
    rows
}

/// Pick the session's signature line height from the first frame (reference
/// `preprocess::set_line_height`, which caches one value per page).
///
/// Text-dense pages keep the default 2px: every signature row is distinctive.
/// Smooth pages (photos, gradients) carry almost no row-to-row change, so a
/// wider 4px band averages capture noise down without smearing any detail
/// finer than the band — and `refine_offset` restores sub-band precision
/// afterwards, so the coarser grid cannot bias the committed offset.
pub fn choose_line_height(first: &RgbaImage) -> u32 {
    let rows = row_luma(first, 1);
    let w = first.width() as usize;
    if w == 0 || rows.len() < w * 16 {
        return LINE_HEIGHT;
    }
    let h = rows.len() / w;
    // Mean |Δ| between adjacent rows: a page with any text or UI edges lands
    // far above the floor; only near-uniform content (photos, gradients)
    // stays under it.
    let mut diff = 0f64;
    for r in 0..h.saturating_sub(1) {
        let a = &rows[r * w..(r + 1) * w];
        let b = &rows[(r + 1) * w..(r + 2) * w];
        diff += mad(a, b);
    }
    let avg_diff = diff / h.saturating_sub(1) as f64;
    if avg_diff < 2.0 {
        4
    } else {
        LINE_HEIGHT
    }
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

/// Pixel-granularity refinement around the coarse estimate (the role the
/// reference gives its NCC refinement stage after the LCS candidate).
///
/// Both estimators quantize: the row matcher works on `line_height`-tall
/// signature rows, so its offsets land on that grid and a wheel delta off
/// the grid leaves a systematic ±(line_height−1)px error that pixel
/// verification would rightly reject. A ±(line_height+2)px sampled-MAE sweep
/// at 1px steps restores exact offsets, evaluated outward from the coarse
/// value so ties resolve to the estimate already chosen.
fn refine_offset(prev: &RgbaImage, next: &RgbaImage, coarse: i64, line_height: u32) -> i64 {
    let (w, h) = prev.dimensions();
    let h = h as i64;
    let xs = sample_xs(w);
    let radius = line_height as i64 + 2;
    let mut lags: Vec<i64> = (coarse - radius..=coarse + radius).collect();
    lags.sort_by_key(|&l| (l - coarse).abs());

    let mut best = coarse.max(1);
    let mut best_mae = f64::MAX;
    for &lag in &lags {
        if lag < 1 {
            continue;
        }
        let overlap = h - lag;
        if overlap < MIN_OVERLAP as i64 {
            continue;
        }
        let inset = EDGE_INSET as i64;
        let mut acc = 0f64;
        let mut n = 0f64;
        let mut dy = inset;
        while dy < overlap - inset {
            for &x in &xs {
                let a = luma_at(prev, x, (lag + dy) as u32);
                let b = luma_at(next, x, dy as u32);
                acc += (a - b).abs();
                n += 1.0;
            }
            dy += 2;
        }
        if n > 0.0 && acc / n < best_mae {
            best_mae = acc / n;
            best = lag;
        }
    }
    best
}

/// Sampled-MAE argmin over a ±`radius` window at 1px steps (the estimator half
/// of the reference's `seam` stage; `verify_alignment` re-gates the winner).
/// Ties resolve to `center` — the already-verified estimate — so the sweep can
/// only move the commit when a candidate is strictly better.
fn seam_sweep(prev: &RgbaImage, next: &RgbaImage, center: i64, radius: i64) -> i64 {
    let (w, h) = prev.dimensions();
    let h = h as i64;
    let xs = sample_xs(w);
    let mut best = center;
    let mut best_mae = f64::MAX;
    for lag in (center - radius).max(1)..=(center + radius) {
        let overlap = h - lag;
        if overlap < MIN_OVERLAP as i64 {
            continue;
        }
        let inset = EDGE_INSET as i64;
        let mut acc = 0f64;
        let mut n = 0f64;
        let mut dy = inset;
        while dy < overlap - inset {
            for &x in &xs {
                let a = luma_at(prev, x, (lag + dy) as u32);
                let b = luma_at(next, x, dy as u32);
                acc += (a - b).abs();
                n += 1.0;
            }
            dy += 2;
        }
        if n > 0.0 {
            let mae = acc / n;
            // Strict `<` (not `<=`) keeps `center` on ties.
            if mae < best_mae {
                best_mae = mae;
                best = lag;
            }
        }
    }
    best
}

/// SSIM of two equal-length luma slices (0..1), one per row over the sampled
/// columns (reference `verify::overlap_ssim`, evaluated row-wise). Standard
/// single-scale formula with the 8-bit constants C1=(0.01·255)², C2=(0.03·255)²;
/// flat rows (σ≈0 on both sides) correctly score ≈1 through the constants.
fn row_ssim(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len().min(b.len());
    if n == 0 {
        return 1.0;
    }
    let (mut sa, mut sb, mut saa, mut sbb, mut sab) = (0f64, 0f64, 0f64, 0f64, 0f64);
    for i in 0..n {
        sa += a[i];
        sb += b[i];
        saa += a[i] * a[i];
        sbb += b[i] * b[i];
        sab += a[i] * b[i];
    }
    let nn = n as f64;
    let (ma, mb) = (sa / nn, sb / nn);
    let va = saa / nn - ma * ma;
    let vb = sbb / nn - mb * mb;
    let cov = sab / nn - ma * mb;
    let (c1, c2) = (6.5025, 58.5225);
    ((2.0 * ma * mb + c1) * (2.0 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2))
}

/// The verifier's measurements over the aligned overlap (reference
/// `verify::overlap_mae / overlap_ssim / overlap_edge_ncc / row`).
#[derive(Debug, Clone, Copy)]
pub struct VerifyReport {
    pub mae: f64,
    pub edge_ncc: f64,
    pub row_score: f64,
    pub ssim: f64,
    /// Sampled positions behind the report; 0 means the whole overlap was
    /// sticky UI (the caller treats that as Still, nothing scrollable).
    pub samples: u64,
}

impl VerifyReport {
    pub fn ok(&self) -> bool {
        self.samples > 0
            && self.mae <= MAX_MAE
            && self.edge_ncc >= MIN_EDGE_NCC
            && self.row_score >= MIN_ROW_INTEGRITY
            && self.ssim >= MIN_SSIM
    }
}

fn verify_rejected() -> VerifyReport {
    VerifyReport {
        mae: 255.0,
        edge_ncc: -1.0,
        row_score: 0.0,
        ssim: 0.0,
        samples: 1,
    }
}

/// Pixel-level verification of `offset` between the previously appended frame
/// and the new one (reference `V2Engine::verify`). Rows identical at the same
/// frame-local y (fixed header/footer) are excluded, mirroring the signature
/// mask the matcher uses; MAE, edge NCC, row integrity and SSIM all have to
/// pass over the non-sticky overlap.
pub fn verify_alignment(prev: &RgbaImage, next: &RgbaImage, offset: i64) -> VerifyReport {
    if prev.dimensions() != next.dimensions() || offset < 1 {
        return verify_rejected();
    }
    let (w, h) = prev.dimensions();
    let overlap = ((next.height() as i64 - offset)
        .min(h as i64 - offset)
        .max(0)) as u32;
    if overlap < MIN_OVERLAP {
        return verify_rejected();
    }
    let xs = sample_xs(w);
    let inset = EDGE_INSET;
    let check = overlap.saturating_sub(inset * 2);
    let y_prev_start = offset as u32;

    // Sticky rows: identical luma at the SAME frame-local y in both frames —
    // the pixel-level twin of the signature mask (fixed header/footer). An
    // aligned pair is masked when EITHER side lands on one, which also
    // removes the polluted zone where the old frame's footer overlaps the
    // new frame's fresh content.
    let h_rows = h.min(next.height()) as usize;
    let row_diff: Vec<f64> = (0..h_rows)
        .map(|y| {
            xs.iter()
                .map(|&x| (luma_at(prev, x, y as u32) - luma_at(next, x, y as u32)).abs())
                .sum::<f64>()
                / xs.len() as f64
        })
        .collect();
    let same_y_fixed = |y: u32| (y as usize) < row_diff.len() && row_diff[y as usize] < 1.0;
    let sticky: Vec<bool> = (inset..check + inset)
        .map(|dy| same_y_fixed(y_prev_start + dy) || same_y_fixed(dy))
        .collect();

    let mut mae_acc = 0f64;
    let mut n = 0u64;
    let mut ssim_acc = 0f64;
    let mut ssim_rows = 0u64;
    let mut rows_ok = 0usize;
    let mut rows_total = 0usize;
    let mut ea = Vec::new();
    let mut eb = Vec::new();
    for (i, dy) in (inset..check + inset).enumerate() {
        if sticky[i] {
            continue;
        }
        let mut ra = Vec::with_capacity(xs.len());
        let mut rb = Vec::with_capacity(xs.len());
        let mut row_mae = 0f64;
        for &x in &xs {
            let a = luma_at(prev, x, y_prev_start + dy);
            let b = luma_at(next, x, dy);
            mae_acc += (a - b).abs();
            row_mae += (a - b).abs();
            n += 1;
            ra.push(a);
            rb.push(b);
        }
        if !ra.is_empty() {
            ssim_acc += row_ssim(&ra, &rb);
            ssim_rows += 1;
            if row_mae / (ra.len() as f64) < 24.0 {
                rows_ok += 1;
            }
        }
        rows_total += 1;
        ea.push(row_edge(prev, y_prev_start + dy));
        eb.push(row_edge(next, dy));
    }

    let mae = if n > 0 { mae_acc / n as f64 } else { 255.0 };
    let ssim = if ssim_rows > 0 {
        ssim_acc / ssim_rows as f64
    } else {
        0.0
    };
    let edge_ncc = if ea.len() >= 8 {
        let va = slice_variance(&ea);
        let vb = slice_variance(&eb);
        if va < 1e-9 || vb < 1e-9 {
            // Constant edge energy on either side (smooth gradients, flat
            // art): the gate has no signal and stays out of the way — the
            // other three gates carry the decision.
            1.0
        } else {
            ncc_slices(&ea, &eb)
        }
    } else {
        // Not enough non-sticky rows to judge: accept on the estimator's
        // evidence alone (this is a mostly-fixed viewport).
        1.0
    };
    let row_score = if rows_total > 0 {
        rows_ok as f64 / rows_total as f64
    } else {
        1.0
    };
    VerifyReport {
        mae,
        edge_ncc,
        row_score,
        ssim,
        samples: n,
    }
}

/// Refine, sanity-check and verify one candidate offset — the shared tail of
/// the multi-source estimate (reference `select_offset` → `verify`).
fn evaluate_candidate(
    source: &str,
    prev: &RgbaImage,
    next: &RgbaImage,
    offset: i64,
    confidence: f64,
    line_height: u32,
) -> FrameDecision {
    // Pixel refinement: correct the coarse grid's quantization before any
    // plausibility or verification uses the offset.
    let refined = refine_offset(prev, next, offset, line_height);
    if refined != offset {
        log::info!("[长截图][v2] {source} offset={offset} → 像素精化 {refined}");
    }
    let offset = refined;

    if offset > MAX_STEP as i64 {
        return FrameDecision::TooLarge;
    }
    let report = verify_alignment(prev, next, offset);
    // A page that is entirely sticky (nothing scrollable matched) is Still.
    if report.samples == 0 {
        return FrameDecision::Still;
    }
    if !report.ok() {
        log::info!(
            "[长截图][v2] 拒绝硬拼 mae={:.1} edge_ncc={:.2} row={:.2} ssim={:.2}",
            report.mae,
            report.edge_ncc,
            report.row_score,
            report.ssim
        );
        if cfg!(test) {
            eprintln!(
                "[probe] src={source} off={offset} conf={confidence:.2} mae={:.1} \
                 edge={:.2} row={:.2} ssim={:.2} REJECT",
                report.mae, report.edge_ncc, report.row_score, report.ssim
            );
        }
        return FrameDecision::VerifyFailed;
    }

    // Seam stage (reference `v2 timing stage=seam`): a verifier pass with
    // residual error means the candidate is only approximately right — on
    // smooth pages several offsets clear every gate. Sweep ±SEAM_RADIUS and
    // re-gate the argmin; it must beat the estimate by SEAM_MARGIN to move
    // the commit.
    let (offset, report) = if report.mae > SEAM_CLEAN_MAE {
        let cand = seam_sweep(prev, next, offset, SEAM_RADIUS);
        if cand != offset {
            let r2 = verify_alignment(prev, next, cand);
            if r2.ok() && r2.mae + SEAM_MARGIN < report.mae {
                log::info!(
                    "[长截图][v2] seam {offset} → {cand} (mae {:.2} → {:.2})",
                    report.mae,
                    r2.mae
                );
                (cand, r2)
            } else {
                (offset, report)
            }
        } else {
            (offset, report)
        }
    } else {
        (offset, report)
    };
    log::info!(
        "[长截图][v2] src={source} offset={offset} conf={confidence:.2} mae={:.1} \
         edge_ncc={:.2} row={:.2} ssim={:.2}",
        report.mae,
        report.edge_ncc,
        report.row_score,
        report.ssim
    );
    if cfg!(test) {
        eprintln!(
            "[probe] src={source} off={offset} conf={confidence:.2} mae={:.1} \
             edge={:.2} row={:.2} ssim={:.2}",
            report.mae, report.edge_ncc, report.row_score, report.ssim
        );
    }
    FrameDecision::Append { offset, confidence }
}

/// The full per-frame decision (reference `V2Engine::estimate` + `verify`).
///
/// `prev` is the previously appended frame, `next` the freshly captured one,
/// `prior` the recent scroll step to bias the search around, `line_height`
/// the session's signature height. Multi-source estimation: the row matcher
/// runs first; the FFT-NCC estimator rescues when its evidence is too weak —
/// the scroll step sits off the signature grid, or signature averaging
/// washed out the sub-band detail — or when its offset fails verification.
/// Every candidate independently passes the verifier before an append is
/// allowed: 宁可少拼一帧，也不硬拼.
pub fn decide_with(
    prev: &RgbaImage,
    next: &RgbaImage,
    prior: i64,
    line_height: u32,
) -> FrameDecision {
    if prev.dimensions() != next.dimensions() {
        return FrameDecision::VerifyFailed;
    }
    if looks_still(prev, next) {
        return FrameDecision::Still;
    }

    let (w, _h) = prev.dimensions();
    let prev_rows = row_luma(prev, line_height);
    let next_rows = row_luma(next, line_height);
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

    let mut outcome = FrameDecision::LowConfidence;
    if evidence.confidence >= MIN_CONFIDENCE {
        outcome = evaluate_candidate(
            "lcs",
            prev,
            next,
            evidence.offset * line_height as i64,
            evidence.confidence,
            line_height,
        );
    }
    if matches!(outcome, FrameDecision::Append { .. }) {
        return outcome;
    }
    if let Some(ev2) = fft::column_fft_ncc_offset(prev, next) {
        let tried = evaluate_candidate("fft", prev, next, ev2.offset, ev2.confidence, line_height);
        if matches!(tried, FrameDecision::Append { .. }) {
            return tried;
        }
        // An evaluated offset beats a confidence short-fall as the reported
        // reason; an LCS plausibility failure stays primary.
        if matches!(outcome, FrameDecision::LowConfidence) {
            outcome = tried;
        }
    } else if matches!(outcome, FrameDecision::LowConfidence) {
        // Low confidence is recoverable by re-capturing in place (原地重抓);
        // the session controller decides how many times to retry.
        log::info!(
            "[长截图][v2] fail-closed offset={} conf={:.2} (< {MIN_CONFIDENCE:.2}) → 原地重抓",
            evidence.offset * line_height as i64,
            evidence.confidence
        );
    }
    outcome
}

/// `decide` with the default signature height (tests and simple callers).
pub fn decide(prev: &RgbaImage, next: &RgbaImage, prior: i64) -> FrameDecision {
    decide_with(prev, next, prior, LINE_HEIGHT)
}

/// Older-frame rescue (reference `engine::relative_offset_from_older` over
/// the `frame_ring`): when nothing aligns with the last appended frame —
/// signature aliasing against that particular baseline — the same capture can
/// still align against the frame before it. The committed offset converts the
/// older baseline's match into an offset from the accumulated tail, and the
/// normal verifier gates it before any append. Returns the effective append
/// offset, or None to keep failing closed.
pub fn rescue_offset(
    stitcher: &Stitcher,
    frame: &RgbaImage,
    prior: i64,
    line_height: u32,
) -> Option<i64> {
    let older = stitcher.rescue_baseline(1)?;
    let committed = stitcher.last_committed()?;
    let FrameDecision::Append { offset, .. } = decide_with(older, frame, prior, line_height) else {
        return None;
    };
    let effective = offset - committed;
    if effective <= 0 || effective > MAX_STEP as i64 {
        return None;
    }
    verify_alignment(stitcher.last_frame(), frame, effective)
        .ok()
        .then_some(effective)
}

/// Population variance of a slice.
fn slice_variance(v: &[f64]) -> f64 {
    let n = v.len() as f64;
    if n < 2.0 {
        return 0.0;
    }
    let s: f64 = v.iter().sum();
    let s2: f64 = v.iter().map(|&x| x * x).sum();
    (s2 - s * s / n) / n
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
        return 12;
    }
    let mut sorted = tail;
    sorted.sort_unstable();
    sorted[sorted.len() / 2]
}

/// Column FFT-NCC displacement estimation (reference `fft_ncc`:
/// `column_fft_ncc_curve` + `estimate_with_margins`).
///
/// For every sampled column the two frames' luma vectors are correlated over
/// the full plausible lag range via the correlation theorem, with per-lag
/// mean/variance normalization from prefix sums. The per-column NCC curves
/// are averaged; the peak's height times the fraction of columns that
/// independently voted within ±2px of it becomes the confidence.
///
/// The columns are correlated RAW — sticky rows are not blanked. Zeroing the
/// same rows in both vectors destroys the b[j]·a[j+o] products at every
/// nonzero lag while leaving the mean terms intact, which inverts the curve
/// exactly at the true displacement; a fixed bar's own lag-0 leakage falls
/// outside the searched range (o ≥ 1), so the raw correlation is both safer
/// and simpler.
mod fft {
    use super::{luma_at, sample_xs, MatchEvidence, MAX_STEP, MIN_OVERLAP};
    use image::RgbaImage;
    use rustfft::{num_complex::Complex, FftPlanner};

    /// Columns with less variance than this carry no alignment signal and are
    /// skipped rather than diluting the average curve.
    const MIN_COL_VARIANCE: f32 = 4.0;
    /// The aggregate peak must clear this mean NCC and this column-consistency
    /// before the estimate is offered to the engine.
    const MIN_PEAK_NCC: f32 = 0.30;
    const MIN_CONSISTENCY: f32 = 0.34;

    pub(super) fn column_fft_ncc_offset(
        prev: &RgbaImage,
        next: &RgbaImage,
    ) -> Option<MatchEvidence> {
        let h = prev.height() as usize;
        let xs = sample_xs(prev.width());
        // n ≥ h + max_lag + 2 keeps the circular correlation wrap-free over
        // the used lag range.
        let max_lag = (MAX_STEP as usize).min(h.saturating_sub(MIN_OVERLAP as usize));
        if max_lag < 8 {
            return None;
        }
        let n = (h + max_lag + 2).next_power_of_two();

        let mut planner = FftPlanner::<f32>::new();
        let fwd = planner.plan_fft_forward(n);
        let inv = planner.plan_fft_inverse(n);

        let mut ncc_sum = vec![0f32; max_lag + 1];
        let mut votes = vec![0u32; max_lag + 1];
        let mut columns = 0u32;

        for &x in &xs {
            let x = x as usize;
            let mut a = vec![0f32; n];
            let mut b = vec![0f32; n];
            for j in 0..h {
                a[j] = luma_at(prev, x as u32, j as u32) as f32;
                b[j] = luma_at(next, x as u32, j as u32) as f32;
            }
            if variance(&a[..h]) < MIN_COL_VARIANCE || variance(&b[..h]) < MIN_COL_VARIANCE {
                continue;
            }

            let (pa, pa2) = prefix_sums(&a, h);
            let (pb, pb2) = prefix_sums(&b, h);

            // c[o] = Σ_j b[j]·a[j+o] over the free (non-circular) part.
            let mut fa: Vec<Complex<f32>> = a.iter().map(|&v| Complex::new(v, 0.0)).collect();
            let mut fb: Vec<Complex<f32>> = b.iter().map(|&v| Complex::new(v, 0.0)).collect();
            fwd.process(&mut fa);
            fwd.process(&mut fb);
            for k in 0..n {
                fa[k] = fb[k].conj() * fa[k];
            }
            inv.process(&mut fa);
            let scale = 1.0 / n as f32;

            // This column's NCC curve over the lag range (0.0 where a window
            // is too flat to judge).
            let mut curve = vec![0f32; max_lag + 1];
            let mut best_lag = 0usize;
            let mut best_val = f32::MIN;
            for o in 1..=max_lag {
                let cnt = (h - o) as f32;
                // Window a[o..h) against b[0..h-o).
                let sa = pa[h] - pa[o];
                let sa2 = pa2[h] - pa2[o];
                let sb = pb[h - o];
                let sb2 = pb2[h - o];
                let va = sa2 - sa * sa / cnt;
                let vb = sb2 - sb * sb / cnt;
                if va <= 1.0 || vb <= 1.0 {
                    continue;
                }
                let cov = fa[o].re * scale - sa * sb / cnt;
                let ncc = cov / (va * vb).sqrt();
                curve[o] = ncc;
                if ncc > best_val {
                    best_val = ncc;
                    best_lag = o;
                }
            }
            // A column whose near-peak set spans a wide lag range — smooth
            // gradients, since NCC is invariant to affine luma maps, so a
            // linear ramp matches at EVERY displacement — carries no
            // displacement information. Skip it entirely rather than letting
            // it flatten the aggregate curve and scatter the votes.
            let peak_width = curve[1..].iter().filter(|&&v| v >= best_val - 0.05).count();
            if peak_width > (max_lag / 8).max(8) {
                continue;
            }
            for o in 1..=max_lag {
                ncc_sum[o] += curve[o];
            }
            if best_val >= MIN_PEAK_NCC {
                votes[best_lag] += 1;
            }
            columns += 1;
        }

        if columns == 0 {
            return None;
        }
        let mut best_lag = 0usize;
        let mut best_mean = f32::MIN;
        for (o, &curve) in ncc_sum.iter().enumerate().take(max_lag + 1).skip(1) {
            let mean = curve / columns as f32;
            if mean > best_mean {
                best_mean = mean;
                best_lag = o;
            }
        }
        if cfg!(test) {
            let lo = best_lag.saturating_sub(2);
            let hi = (best_lag + 2).min(max_lag);
            let cons = votes[lo..=hi].iter().sum::<u32>() as f32 / columns as f32;
            eprintln!(
                "[fft-probe] cols={columns} best_lag={best_lag} best_mean={best_mean:.3} \
                 consistency={cons:.2} target-conf={:.3}",
                best_mean * cons
            );
        }
        let lo = best_lag.saturating_sub(2);
        let hi = (best_lag + 2).min(max_lag);
        let consistency = votes[lo..=hi].iter().sum::<u32>() as f32 / columns as f32;
        if best_mean < MIN_PEAK_NCC || consistency < MIN_CONSISTENCY {
            return None;
        }
        Some(MatchEvidence {
            offset: best_lag as i64,
            confidence: (best_mean * consistency) as f64,
        })
    }

    fn variance(v: &[f32]) -> f32 {
        let n = v.len() as f32;
        if n < 2.0 {
            return 0.0;
        }
        let s: f32 = v.iter().sum();
        let s2: f32 = v.iter().map(|&x| x * x).sum();
        ((s2 - s * s / n) / (n - 1.0)).max(0.0)
    }

    /// (Σ_{j<i} v[j], Σ_{j<i} v[j]²) for i in 0..=h.
    fn prefix_sums(v: &[f32], h: usize) -> (Vec<f32>, Vec<f32>) {
        let mut p = vec![0f32; h + 1];
        let mut p2 = vec![0f32; h + 1];
        for i in 0..h {
            p[i + 1] = p[i] + v[i];
            p2[i + 1] = p2[i] + v[i] * v[i];
        }
        (p, p2)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A synthetic page: horizontal stripes + a moving text band, so every
    /// row is unique enough for row matching.
    fn page(seed: u64, w: u32, h: u32) -> RgbaImage {
        use std::cell::Cell;
        let state = Cell::new(
            seed.wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407),
        );
        let next = || {
            let x = state.get();
            state.set(
                x.wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407),
            );
            (x >> 33) as u8
        };
        let mut img = RgbaImage::new(w, h);
        for y in 0..h {
            // 7px bands whose spacing and phase both depend on the seed: a
            // constant shift can never align two different pages (same
            // multiplier would alias mod 256). Matching at the right offset
            // gives MAD≈0, any misalignment a large MAD — like text.
            let k = (y / 7) % 256;
            let band = (k
                .wrapping_mul(23 + (seed % 13) as u32)
                .wrapping_add((seed % 256) as u32 * 37)
                % 256) as u8;
            for x in 0..w {
                let n = if x % 5 == 0 { next() / 8 } else { 0 };
                let v = band.wrapping_add(n);
                img.put_pixel(
                    x,
                    y,
                    image::Rgba([v, v.wrapping_add(2), 255u8.wrapping_sub(v), 255]),
                );
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
        // Two seeds of the band generator can land a modular-256 coincidence
        // (a translate that genuinely verifies), so "unrelated" is built
        // structurally: the same page flipped vertically. A translate of a
        // reversal is another reversal, and the forward band sequence is
        // never a translate of the reversed one.
        let a = page(11, 260, 400);
        let b = image::imageops::flip_vertical(&a);
        assert!(!matches!(decide(&a, &b, 12), FrameDecision::Append { .. }));
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

    /// 2px bands from an LCG plus a per-column ramp: signature rows are
    /// unique, rows carry edge energy, and a 1px shift compares every row
    /// against its band neighbour (a large luma jump).
    fn banded(seed: u64, w: u32, h: u32) -> RgbaImage {
        use std::cell::Cell;
        let state = Cell::new(
            seed.wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407),
        );
        let next = || {
            let x = state.get();
            state.set(
                x.wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407),
            );
            (x >> 33) as u8
        };
        let mut img = RgbaImage::new(w, h);
        for y in (0..h).step_by(2) {
            let v = next();
            for dy in 0..2.min(h - y) {
                for x in 0..w {
                    let c = v.wrapping_add((x % 9) as u8);
                    img.put_pixel(x, y + dy, image::Rgba([c, c.wrapping_add(4), 255 - c, 255]));
                }
            }
        }
        img
    }

    /// A near-flat page: a 0.12-luma-per-row gradient with a per-column
    /// offset — adjacent rows differ by ~0.1 (wide signatures are chosen)
    /// while every column still carries signal over the frame.
    fn smooth(seed: u64, w: u32, h: u32) -> RgbaImage {
        let mut img = RgbaImage::new(w, h);
        for y in 0..h {
            let base = (y as f64 * 0.12 + (seed % 7) as f64 * 3.0) as u8;
            for x in 0..w {
                let v = base.wrapping_add((x % 11) as u8 * 2);
                img.put_pixel(x, y, image::Rgba([v, v.wrapping_add(3), 255 - v, 255]));
            }
        }
        img
    }

    #[test]
    fn odd_offset_is_recovered() {
        // A 51px scroll sits between the 2px signature grid points: the row
        // matcher lands a pixel off and pixel refinement must correct it
        // before the verifier sees the offset.
        let src = page(9, 300, 2000);
        let a = window_of(&src, 0, 400);
        let b = window_of(&src, 51, 400);
        match decide(&a, &b, 12) {
            FrameDecision::Append { offset, .. } => assert_eq!(offset, 51),
            other => panic!("expected Append, got {other:?}"),
        }
    }

    /// Bands with per-pixel noise on EVERY column: unlike `page` (noise on
    /// x%5==0 only), no column is an affine ramp, so every sampled column
    /// carries displacement information for the FFT estimator.
    fn textured(seed: u64, w: u32, h: u32) -> RgbaImage {
        use std::cell::Cell;
        let state = Cell::new(
            seed.wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407),
        );
        let next = || {
            let x = state.get();
            state.set(
                x.wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407),
            );
            (x >> 33) as u8
        };
        let mut img = RgbaImage::new(w, h);
        for y in 0..h {
            let k = (y / 7) % 256;
            let band = (k
                .wrapping_mul(23 + (seed % 13) as u32)
                .wrapping_add((seed % 256) as u32 * 37)
                % 256) as u8;
            for x in 0..w {
                let n = next() / 16;
                let v = band.wrapping_add(n);
                img.put_pixel(
                    x,
                    y,
                    image::Rgba([v, v.wrapping_add(2), 255u8.wrapping_sub(v), 255]),
                );
            }
        }
        img
    }

    #[test]
    fn fft_estimator_pins_exact_lag() {
        let src = textured(17, 300, 2000);
        let a = window_of(&src, 0, 400);
        let b = window_of(&src, 137, 400);
        let ev = super::fft::column_fft_ncc_offset(&a, &b).expect("fft evidence");
        assert_eq!(ev.offset, 137);
        assert!(ev.confidence >= 0.55, "conf={}", ev.confidence);
    }

    #[test]
    fn smooth_page_gets_wider_signatures() {
        let src = smooth(3, 300, 1600);
        assert_eq!(choose_line_height(&window_of(&src, 0, 400)), 4);
        let a = window_of(&src, 0, 400);
        let b = window_of(&src, 51, 400);
        match decide_with(&a, &b, 12, 4) {
            FrameDecision::Append { offset, .. } => assert_eq!(offset, 51),
            other => panic!("expected Append, got {other:?}"),
        }
    }

    #[test]
    fn ssim_prefers_true_alignment() {
        let src = banded(23, 260, 1200);
        let a = window_of(&src, 0, 400);
        let good = window_of(&src, 90, 400);
        let shifted = window_of(&src, 91, 400);
        let r_good = verify_alignment(&a, &good, 90);
        let r_bad = verify_alignment(&a, &shifted, 90);
        assert!(r_good.ok(), "good: {r_good:?}");
        assert!(!r_bad.ok(), "bad: {r_bad:?}");
        assert!(r_good.ssim > r_bad.ssim);
    }

    /// The smooth-page tear, reduced from the replay corpus: wide bands of
    /// near-uniform luma (the showcase gradients) make a ~10px-offset alias
    /// pass every verifier gate — on real rendered frames a 240px step was
    /// accepted as 230px with mae=6.4, and committing it duplicated 10px at
    /// the seam. The seam stage must recover the exact offset from a ±12px
    /// neighbourhood of a verified-but-imperfect candidate.
    ///
    /// Construction: a slow vertical gradient (≈0.2 luma/px — the wrong offset
    /// keeps MAE ≈2, under every gate) plus sparse text-like marks every 64px
    /// (edge energy per row is constant, so the edge gate's flat-signal
    /// bypass keeps it at 1.0, exactly like the real gradient bands).
    fn smooth_page(seed: u64, w: u32, h: u32) -> RgbaImage {
        let mut img = RgbaImage::new(w, h);
        for y in 0..h {
            let base = (y as f64 * 0.2 + (seed % 5) as f64) as u8;
            for x in 0..w {
                let n = if x % 64 == 0 { 40 } else { 0 };
                let v = base.wrapping_add(n);
                img.put_pixel(x, y, image::Rgba([v, v.wrapping_add(3), 255 - v, 255]));
            }
        }
        img
    }

    #[test]
    fn seam_stage_corrects_smooth_page_alias() {
        let src = smooth_page(77, 320, 3000);
        let a = window_of(&src, 0, 800);
        let b = window_of(&src, 240, 800);
        // The alias: verified and accepted at 230 (pre-seam behaviour).
        let r = verify_alignment(&a, &b, 230);
        assert!(r.ok(), "alias unexpectedly rejected: {r:?}");
        assert!(
            r.mae > SEAM_CLEAN_MAE,
            "alias should carry residual error: {r:?}"
        );
        // The sweep finds the true displacement and the margin is met.
        assert_eq!(seam_sweep(&a, &b, 230, SEAM_RADIUS), 240);
        let r240 = verify_alignment(&a, &b, 240);
        assert!(r240.ok());
        assert!(r240.mae + SEAM_MARGIN < r.mae);
    }

    #[test]
    fn rescue_offset_recovers_ring_geometry() {
        use crate::scroll::stitch::Stitcher;
        let src = page(29, 240, 2000);
        let mut stitcher = Stitcher::new(window_of(&src, 0, 400));
        let mut y = 0u32;
        for &off in &[80i64, 96, 64] {
            y += off as u32;
            let frame = window_of(&src, y, 400);
            let d = decide(stitcher.last_frame(), &frame, 12);
            let FrameDecision::Append { offset, .. } = d else {
                panic!("expected append, got {d:?}")
            };
            stitcher.append(frame, &d, offset);
        }
        // A capture 51px below the accumulated tail: against the ring's
        // older frame the displacement is (last committed) + 51, and the
        // rescue must fold that back into an offset from the tail.
        let next = window_of(&src, y + 51, 400);
        assert_eq!(rescue_offset(&stitcher, &next, 12, LINE_HEIGHT), Some(51));
    }
}
