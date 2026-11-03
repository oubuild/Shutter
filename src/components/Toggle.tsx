/**
 * A macOS-style switch, sized to sit inside a popover menu row.
 *
 * Geometry is explicit (no translate dependencies): a 40×24 pill with a 20px
 * knob that keeps a 2px inset on either end, so the knob can never read as
 * overflowing the track. Controlled only — the row owns the state (and the
 * persistence behind it), exactly like the app-row toggles in the settings
 * pane. ON uses the app's primary (the same near-black as btn-primary),
 * matching the shadcn-zinc vocabulary the whole UI is built from.
 */

type Props = {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Announced by screen readers; the visible label lives in the row. */
  label: string;
};

export function Toggle({ checked, onChange, disabled = false, label }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`relative h-6 w-10 flex-none rounded-full border-none transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 ${
        checked ? "bg-primary-500 dark:bg-neutral-200" : "bg-neutral-300 dark:bg-neutral-600"
      } ${disabled ? "pointer-events-none op-45" : ""}`}
      /* The host row toggles too; a click on the switch itself must not fire both. */
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
    >
      <span
        className={`absolute top-[2px] h-5 w-5 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.3)] transition-all duration-150 ${
          checked ? "left-[18px] dark:bg-neutral-900" : "left-[2px]"
        }`}
      />
    </button>
  );
}
