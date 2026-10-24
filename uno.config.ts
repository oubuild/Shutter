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
          "border border-neutral-300 rounded flex gap-2 items-center px2.5 py1.5 color-base hover:bg-hover hover:border-neutral-400 transition disabled:pointer-events-none disabled:op40! outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40",
        "btn-primary":
          "px2.5 py1.5 rounded border border-transparent flex gap-2 items-center bg-primary-500 hover:bg-primary-600 text-white font-500 transition disabled:op50 disabled:pointer-events-none outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40",
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
*, ::before, ::after { box-sizing: border-box; border-width: 0; border-style: solid; border-color: #e5e7eb; }
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
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.22);
  border: 2px solid transparent;
  background-clip: content-box;
  border-radius: 999px;
}
::-webkit-scrollbar-thumb:hover { background: rgba(0, 0, 0, 0.34); background-clip: content-box; border: 2px solid transparent; }
::-webkit-scrollbar-corner { background: transparent; }
@keyframes thumb-shimmer { from { background-position: 140% 0; } to { background-position: -40% 0; } }
`,
    },
  ],
  theme: {
    fontFamily: {
      sans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif',
      mono: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace',
    },
    // Shutter AI visual spec. Plain hex tokens (not the OKLCH antfu scales)
    // so a future dark theme only has to swap these values.
    colors: {
      surface: { DEFAULT: "#FFFFFF", alt: "#F5F6F8" },
      ink: { DEFAULT: "#24262B", dim: "#858A94" },
      line: { DEFAULT: "#E5E7EB", strong: "#D8DBE0" },
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

    // App-level composites reused across the settings pane.
    "app-card": "bg-base border border-base rounded-lg overflow-hidden",
    "app-card-head": "flex items-center gap-3 px-4 py-3 border-b border-mute",
    "app-row": "grid grid-cols-[168px_minmax(0,1fr)] gap-4 px-4 py-3 border-t border-mute",
    "app-row-toggle": "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 border-t border-mute",
    "app-label": "pt-1.5 text-compact color-muted",
    "app-field":
      'w-full h-8 rounded border bg-base px-2.5 py-0 text-compact color-base outline-none transition focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 placeholder:color-faint',
    "app-hint": "m-0 text-mini color-faint leading-relaxed",
    "app-meta": "font-mono tabular-nums text-mini color-faint truncate",
    "app-kbd":
      "inline-flex items-center justify-center min-w-14 px-1.5 py-0.5 rounded border border-neutral-300 bg-sunken font-mono text-mini color-muted leading-none",

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
