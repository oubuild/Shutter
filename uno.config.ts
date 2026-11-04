import { presetAnthonyDesign } from "@antfu/design/unocss";
import transformerDirectives from "@unocss/transformer-directives";
import { defineConfig, presetWind3 } from "unocss";

/**
 * UnoCSS setup.
 *
 * `presetAnthonyDesign` contributes the semantic layer only (bg-base,
 * color-muted, border-base, btn-action, badge, color-scale-*, …) — the base
 * preset, fonts and reset are ours. `presetWind3` is the base: the app still
 * targets Safari 15 (macOS 12), so the Wind4 output (color-mix, @property) is
 * deliberately avoided.
 *
 * The antfu preset ships no z-index scale and blocks plain `z-<n>`; the named
 * layers it expects are declared below. The settings pane itself is
 * single-layer, so they exist for future overlays rather than for today's UI.
 */
export default defineConfig({
  presets: [
    presetAnthonyDesign({
      // shadcn/ui zinc palette. The primary action colour is zinc-900
      // (#18181b) with a zinc-800 (#27272a) hover — shadcn lightens its
      // near-black primary on hover (bg-primary/90), so 600 is deliberately
      // one step lighter rather than darker. A full scale object is passed
      // (not a hex) because generateColorRamp re-steps lightness and would
      // turn a near-black input into a mid-gray primary-500. Remaining stops
      // follow the zinc ramp for tints.
      primary: {
        50: "#fafafa",
        100: "#f4f4f5",
        200: "#e4e4e7",
        300: "#d4d4d8",
        400: "#a1a1aa",
        500: "#18181b",
        600: "#27272a",
        700: "#3f3f46",
        800: "#52525b",
        900: "#71717a",
        950: "#09090b",
        DEFAULT: "#18181b",
      },
      // The shipped action button uses a 13%-alpha border, which reads as plain
      // text on the white cards this app is built from. One step stronger keeps
      // the antfu vocabulary but restores the button affordance.
      overrides: {
        "btn-action":
          "border border-neutral-300 dark:border-neutral-700 rounded-md flex gap-2 items-center px2.5 py1.5 color-base bg-base hover:bg-hover hover:border-neutral-400 dark:hover:border-neutral-600 shadow-[0_1px_1px_rgba(0,0,0,0.05)] active:translate-y-[0.5px] active:shadow-[inset_0_1px_1px_rgba(0,0,0,0.08)] transition disabled:pointer-events-none disabled:op40! outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40",
        "btn-primary":
          "px2.5 py1.5 rounded-md border border-transparent flex gap-2 items-center bg-primary-500 hover:bg-primary-600 dark:bg-neutral-200 dark:hover:bg-white dark:text-neutral-900 text-white font-500 shadow-[0_1px_2px_rgba(0,0,0,0.12)] active:translate-y-[0.5px] transition disabled:op50 disabled:pointer-events-none outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40",
      },
    }),
    presetWind3(),
  ],
  transformers: [transformerDirectives()],
  // App-wide base styles. The only hand-written CSS left outside capture.css is
  // this reset/scrollbar block; every component composes utilities on top.
  preflights: [
    {
      getCSS: () => `
:root {
  --sh-surface: #FFFFFF;
  --sh-surface-alt: #F5F6F8;
  --sh-ink: #24262B;
  --sh-ink-dim: #858A94;
  --sh-line: #E5E7EB;
  --sh-line-strong: #D8DBE0;
}
.dark {
  --sh-surface: #1D1D20;
  --sh-surface-alt: #2C2C30;
  --sh-ink: #E6E6E9;
  --sh-ink-dim: #9B9BA2;
  --sh-line: #35353A;
  --sh-line-strong: #48484E;
}
*, ::before, ::after { box-sizing: border-box; border-width: 0; border-style: solid; border-color: #e5e7eb; }
.dark *, .dark ::before, .dark ::after { border-color: #35353a; }
html, body, #root { height: 100%; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
  -webkit-font-smoothing: antialiased;
  user-select: none;
  cursor: default;
  background: transparent;
  overflow: hidden;
}
button { font: inherit; color: inherit; cursor: pointer; background: transparent; padding: 0; }
input, textarea, select { font: inherit; color: inherit; }
* { scrollbar-width: thin; scrollbar-color: rgba(0, 0, 0, 0.22) transparent; }
.dark * { scrollbar-color: rgba(255, 255, 255, 0.24) transparent; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.22);
  border: 2px solid transparent;
  background-clip: content-box;
  border-radius: 999px;
}
.dark ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.24); background-clip: content-box; border: 2px solid transparent; }
::-webkit-scrollbar-thumb:hover { background: rgba(0, 0, 0, 0.34); background-clip: content-box; border: 2px solid transparent; }
.dark ::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.36); background-clip: content-box; border: 2px solid transparent; }
::-webkit-scrollbar-corner { background: transparent; }
@keyframes thumb-shimmer { from { background-position: 140% 0; } to { background-position: -40% 0; } }
@keyframes menu-pop { from { opacity: 0; transform: translateY(-6px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
.menu-pop { animation: menu-pop 170ms cubic-bezier(0.16, 1, 0.3, 1); }
@keyframes dialog-pop { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
.dialog-pop { animation: dialog-pop 180ms cubic-bezier(0.16, 1, 0.3, 1); }
@keyframes toast-in { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
.toast-in { animation: toast-in 180ms cubic-bezier(0.16, 1, 0.3, 1); }
.thumb-shimmer { background: linear-gradient(110deg, #e9eaee 30%, #f5f6f8 50%, #e9eaee 70%); background-size: 200% 100%; animation: thumb-shimmer 1.4s ease-in-out infinite; }
.dark .thumb-shimmer { background: linear-gradient(110deg, #232327 30%, #2d2d32 50%, #232327 70%); background-size: 200% 100%; }
.preview-stage { background-color: #F0F1F3; background-image: radial-gradient(rgba(0, 0, 0, 0.10) 1px, transparent 1px); background-size: 16px 16px; }
.dark .preview-stage { background-color: #121316; background-image: radial-gradient(rgba(255, 255, 255, 0.08) 1px, transparent 1px); background-size: 16px 16px; }
.checkerboard { background-color: #f7f7f8; background-image: linear-gradient(45deg, #ececee 25%, transparent 25%), linear-gradient(-45deg, #ececee 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #ececee 75%), linear-gradient(-45deg, transparent 75%, #ececee 75%); background-size: 16px 16px; background-position: 0 0, 0 8px, 8px -8px, -8px 0px; }
.dark .checkerboard { background-color: #1a1a1d; background-image: linear-gradient(45deg, #242428 25%, transparent 25%), linear-gradient(-45deg, #242428 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #242428 75%), linear-gradient(-45deg, transparent 75%, #242428 75%); }
`,
    },
  ],
  theme: {
    fontFamily: {
      sans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif',
      mono: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace',
    },
    // Shutter AI visual spec. CSS-variable tokens (not the OKLCH antfu
    // scales) so the dark theme only swaps the variable block in preflights.
    // Plain vars — not rgb(...) triples — because these are never used with
    // opacity modifiers (Safari 15 has no color-mix for that anyway).
    colors: {
      surface: { DEFAULT: "var(--sh-surface)", alt: "var(--sh-surface-alt)" },
      ink: { DEFAULT: "var(--sh-ink)", dim: "var(--sh-ink-dim)" },
      line: { DEFAULT: "var(--sh-line)", strong: "var(--sh-line-strong)" },
    },
  },
  shortcuts: {
    // Semantic layers the antfu overlay primitives reference.
    "z-nav": "z-[30]",
    "z-dropdown": "z-[40]",
    "z-tooltip": "z-[45]",
    "z-toast": "z-[50]",
    "z-modal-backdrop": "z-[60]",
    "z-modal-content": "z-[70]",
    "z-drawer-backdrop": "z-[80]",
    "z-drawer-content": "z-[90]",

    // App-level composites reused across the settings pane. The radius
    // ladder: controls 6 (rounded-md), cards 12 (rounded-xl), popovers 24.
    "app-card": "bg-base border border-base rounded-xl overflow-hidden",
    "app-card-head": "flex items-center gap-3 px-4 py-3 border-b border-mute",
    "app-row": "grid grid-cols-[168px_minmax(0,1fr)] gap-4 px-4 py-3 border-t border-mute",
    "app-row-toggle": "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 border-t border-mute",
    "app-label": "pt-1.5 text-compact color-muted",
    "app-field":
      'w-full h-8 rounded-md border border-neutral-300 dark:border-neutral-700 bg-base px-2.5 py-0 text-compact color-base outline-none transition shadow-[inset_0_1px_1.5px_rgba(0,0,0,0.04)] hover:border-neutral-400 dark:hover:border-neutral-600 focus:border-primary-500 focus:shadow-none focus:ring-2 focus:ring-primary-500/20 placeholder:color-faint',
    "app-hint": "m-0 text-mini color-faint leading-relaxed",
    "app-meta": "font-mono tabular-nums text-mini color-faint truncate",
    "app-kbd":
      "inline-flex items-center justify-center min-w-7 px-1.5 py-0.5 rounded-[6px] border border-neutral-300 border-b-2 border-b-neutral-400 bg-gradient-to-b from-white to-neutral-100 font-mono text-mini font-500 color-base leading-none shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:border-neutral-700 dark:border-b-neutral-600 dark:from-neutral-700 dark:to-neutral-800 dark:color-neutral-200",

    // macOS System-Settings flat form rows: right-aligned label column,
    // controls to the right, uppercase group captions aligned over the
    // control column, hairline dividers indented to match.
    "pref-row": "flex items-center gap-0",
    "pref-row-top": "flex items-start gap-0",
    "pref-label": "w-[110px] flex-none pr-4 text-right text-[13px] font-500 color-muted",
    "pref-label-pt": "pt-1.5 w-[110px] flex-none pr-4 text-right text-[13px] font-500 color-muted",
    "pref-control": "min-w-0 flex-1 max-w-[420px]",
    "pref-group-title": "pl-[126px] text-[11px] font-600 tracking-wider uppercase color-faint",
    "pref-divider": "my-4 ml-[126px] border-t border-mute",

    // Shutter AI window (Chat.tsx): 32px toolbar controls, 36px primary CTAs
    // (ai-btn-primary), 8px control radius, 12px card radius, spec palette
    // from theme.colors above.
    "ai-btn":
      "inline-flex h-8 flex-none items-center gap-1.5 rounded-lg border border-line bg-surface px-3.5 text-[13px] font-500 color-ink transition hover:bg-surface-alt hover:border-line-strong disabled:pointer-events-none disabled:op-40 outline-none focus-visible:ring-2 focus-visible:ring-primary-500/35",
    "ai-btn-primary":
      "inline-flex h-9 flex-none items-center gap-1.5 rounded-lg border border-transparent bg-primary-500 px-4 text-[13px] font-500 text-white transition hover:bg-primary-600 disabled:pointer-events-none disabled:op-45 outline-none focus-visible:ring-2 focus-visible:ring-primary-500/35",
    "ai-iconbtn":
      "inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg color-ink-dim transition hover:bg-surface-alt hover:color-ink disabled:pointer-events-none disabled:op-40 outline-none focus-visible:ring-2 focus-visible:ring-primary-500/35",
    "ai-card": "bg-surface border border-line rounded-xl overflow-hidden flex flex-col",
    "ai-card-head": "flex h-11 flex-none items-center gap-2 border-b border-line px-3.5",
    "ai-card-title": "text-[13px] font-600 color-ink",
    "ai-headbtn":
      "inline-flex h-7 flex-none items-center gap-1 rounded-md px-2 text-compact font-500 color-ink-dim transition hover:bg-surface-alt hover:color-ink disabled:pointer-events-none disabled:op-40 outline-none focus-visible:ring-2 focus-visible:ring-primary-500/35",
  },
  content: {
    pipeline: {
      include: [/\.(vue|svelte|[jt]sx|mdx?|astro|html)($|\?)/],
    },
  },
});
