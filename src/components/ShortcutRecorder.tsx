/**
 * Hotkey recorder.
 *
 * Click, press a combination, and the row shows the accelerator the way the
 * platform does (⌘⇧A / Ctrl+Shift+A). Recording listens in the capture phase
 * and swallows the keydown, so the combination cannot also trigger the window's
 * own shortcuts while it is being recorded.
 */

import { useEffect, useState } from "react";
import { acceleratorFromEvent, formatAccelerator } from "../lib/shortcut";

type Props = {
  value: string;
  onChange: (accelerator: string) => void;
  /** Told so the pane can suppress ⌘S and other shortcuts while recording. */
  onRecordingChange?: (recording: boolean) => void;
  disabled?: boolean;
};

export function ShortcutRecorder({
  value,
  onChange,
  onRecordingChange,
  disabled = false,
}: Props) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onRecordingChange?.(recording);
  }, [recording, onRecordingChange]);

  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(false);
        setError(null);
        return;
      }
      const result = acceleratorFromEvent(event);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(null);
      setRecording(false);
      onChange(result.accel);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, onChange]);

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <button
        type="button"
        data-testid="shortcut-recorder"
        aria-label="录制截图快捷键"
        aria-pressed={recording}
        disabled={disabled}
        onClick={() => {
          setError(null);
          setRecording((v) => !v);
        }}
        className={`inline-flex h-8 min-w-[132px] items-center justify-center rounded-md border px-3 text-compact transition disabled:op30 ${
          recording
            ? "border-primary-500 bg-primary-500/10 ring-3 ring-primary-500/20"
            : "border-neutral-300 bg-base hover:bg-hover"
        }`}
      >
        {recording ? (
          <span className="text-mini color-primary-600">按下组合键…</span>
        ) : (
          <kbd className="border-0 bg-transparent p-0 font-sans text-compact tracking-wider color-base">
            {formatAccelerator(value)}
          </kbd>
        )}
      </button>
      {recording && !error && (
        <span className="text-mini color-faint">Esc 取消 · 需含 ⌘ / ⌃ / ⌥ / ⇧</span>
      )}
      {error && <span className="text-mini text-error-600">{error}</span>}
    </div>
  );
}
