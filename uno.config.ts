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
      // Apple system blue, matching the rest of the app chrome.
      primary: "#007aff",
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
@keyframes toast-in { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
@keyframes toast-out { to { opacity: 0; } }
@keyframes thumb-shimmer { from { background-position: 140% 0; } to { background-position: -40% 0; } }
`,
    },
  ],
  theme: {
    fontFamily: {
      sans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif',
      mono: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace',
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
  },
  content: {
    pipeline: {
      include: [/\.(vue|svelte|[jt]sx|mdx?|astro|html)($|\?)/],
    },
  },
});
