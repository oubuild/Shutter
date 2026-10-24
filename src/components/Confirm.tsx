/**
 * Small confirmation dialog. Used before destructive actions where the native
 * `window.confirm` would look out of place inside the rounded card. Monochrome
 * by spec: the confirm action is the solid-black primary and the warning lives
 * in the title/message, not in a red button.
 */

import { useEffect } from "react";

type Props = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function Confirm({
  title,
  message,
  confirmLabel = "确定",
  cancelLabel = "取消",
  onConfirm,
  onCancel,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
      if (e.key === "Enter") {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm]);

  return (
    <div
      className="fixed inset-0 z-modal-backdrop flex items-center justify-center bg-black/45 p-6 backdrop-blur-2"
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="w-[340px] rounded-xl border border-base bg-base p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="mb-2 text-compact font-600 color-base">{title}</div>
        <div className="break-all text-mini leading-6 color-muted">{message}</div>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-action" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="btn-primary" onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
