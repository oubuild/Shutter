/**
 * Accelerator helpers shared by the settings pane and the shell.
 *
 * The backend stores hotkeys in the `global-hotkey` accelerator format
 * (`CmdOrControl+Shift+KeyA`). The UI has to do two things with that string:
 * render it the way the platform shows shortcuts (`⌘⇧A` on macOS,
 * `Ctrl+Shift+A` elsewhere), and build one from a keydown event.
 */

export const IS_MAC = /Macintosh|Mac OS X/i.test(navigator.userAgent);

/** Matches `types::default_capture_shortcut()` in Rust. */
export const defaultCaptureShortcut = "CmdOrControl+Shift+KeyA";

/** Matches `types::default_scroll_shortcut()` in Rust. */
export const defaultScrollShortcut = "CmdOrControl+Shift+KeyL";

/** Matches `types::default_pin_shortcut()` in Rust. */
export const defaultPinShortcut = "CmdOrControl+Shift+KeyR";

/** `KeyA` → `A`, `Digit1` → `1`, `Escape` → `Esc`, … */
const KEY_LABELS: Record<string, string> = {
  Enter: "↩",
  Return: "↩",
  Escape: "⎋",
  Space: "Space",
  Tab: "⇥",
  Backspace: "⌫",
  Delete: "⌦",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

/** Key codes the recorder accepts; anything else (pure modifiers, media keys) is rejected. */
export function isRecordableCode(code: string): boolean {
  if (/^Key[A-Z]$/.test(code)) return true;
  if (/^Digit[0-9]$/.test(code)) return true;
  if (/^F([1-9]|1[0-2])$/.test(code)) return true;
  return Object.prototype.hasOwnProperty.call(KEY_LABELS, code);
}

function keyLabel(token: string): string {
  const upper = token.toUpperCase();
  if (upper.startsWith("KEY")) return upper.slice(3);
  if (upper.startsWith("DIGIT")) return upper.slice(5);
  if (IS_MAC && KEY_LABELS[token]) return KEY_LABELS[token];
  const known: Record<string, string> = {
    ENTER: "Enter",
    RETURN: "Enter",
    ESCAPE: "Esc",
    SPACE: "Space",
    TAB: "Tab",
    BACKSPACE: "Backspace",
    DELETE: "Delete",
    ARROWUP: "Up",
    ARROWDOWN: "Down",
    ARROWLEFT: "Left",
    ARROWRIGHT: "Right",
  };
  return IS_MAC ? (known[upper] ?? upper) : (known[upper] ?? token);
}

/**
 * Render an accelerator for display.
 *
 * macOS uses the symbol run (⌃⌥⇧⌘ + key); Windows/Linux spell the modifiers out.
 */
export function formatAccelerator(accel: string): string {
  const tokens = accel
    .split("+")
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return "";
  const key = tokens[tokens.length - 1];
  const mods = tokens.slice(0, -1);

  const upper = mods.map((m) => m.toUpperCase());
  // Exact token matching: "CmdOrControl" contains "CONTROL" as a substring but
  // means ⌘ on macOS, so substring tests would emit a stray ⌃.
  const isCmd = upper.some((m) =>
    ["CMD", "COMMAND", "SUPER", "CMDORCONTROL", "CMDORCTRL", "COMMANDORCONTROL", "COMMANDORCTRL"].includes(m),
  );
  const isCtrl = upper.some((m) => m === "CTRL" || m === "CONTROL");
  const isAlt = upper.some((m) => m === "ALT" || m === "OPTION");
  const isShift = upper.includes("SHIFT");

  if (!IS_MAC) {
    const names: string[] = [];
    if (isCtrl || isCmd) names.push("Ctrl");
    if (isAlt) names.push("Alt");
    if (isShift) names.push("Shift");
    return [...names, keyLabel(key)].join("+");
  }

  // macOS renders modifiers in the order ⌃⌥⇧⌘.
  let symbols = "";
  if (isCtrl) symbols += "⌃";
  if (isAlt) symbols += "⌥";
  if (isShift) symbols += "⇧";
  if (isCmd) symbols += "⌘";
  return symbols + keyLabel(key);
}

export type AcceleratorResult =
  | { ok: true; accel: string; label: string }
  | { ok: false; error: string };

/**
 * Build an accelerator from a keydown event.
 *
 * Refuses bare keys: a global hotkey without a modifier would swallow ordinary
 * typing system-wide.
 */
export function acceleratorFromEvent(event: KeyboardEvent): AcceleratorResult {
  const code = event.code;
  if (!isRecordableCode(code)) {
    return { ok: false, error: "再按一个字母、数字或功能键" };
  }

  const mods: string[] = [];
  if (event.metaKey) mods.push("CmdOrControl");
  if (event.ctrlKey) mods.push("Control");
  if (event.altKey) mods.push("Alt");
  if (event.shiftKey) mods.push("Shift");

  // ⌘ and ⌃ map to the same physical key on some layouts; one is enough.
  if (mods.includes("CmdOrControl") && mods.includes("Control")) {
    mods.splice(mods.indexOf("Control"), 1);
  }
  // A bare key would fire while the user types in any app, so at least one
  // modifier is required — but ONE is enough (the reference presets include
  // single-modifier combos like Option+R); demanding two made every binding
  // a three-key chord for no safety gain.
  if (mods.length < 1) {
    return { ok: false, error: "需要至少一个修饰键（⌘ / ⌃ / ⌥ / ⇧）" };
  }

  const accel = [...mods, code].join("+");
  return { ok: true, accel, label: formatAccelerator(accel) };
}
