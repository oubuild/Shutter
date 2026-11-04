/**
 * A monochrome macOS-style switch (38×22): ON is the app's near-black primary
 * (inverted to light in dark mode, matching btn-primary), OFF a light grey
 * track. Geometry is explicit — the 18px knob keeps a 2px inset on either
 * end, so it can never read as overflowing the track.
 *
 * Controlled only — the row owns the state (and the persistence behind it).
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
      className={`relative h-[22px] w-[38px] flex-none rounded-full border-none transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 ${
        checked ? "bg-primary-500 dark:bg-neutral-200" : "bg-neutral-300 dark:bg-neutral-600"
      } ${disabled ? "pointer-events-none op-45" : ""}`}
      /* The host row toggles too; a click on the switch itself must not fire both. */
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
    >
      <span
        className={`absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-[0_2px_4px_rgba(0,0,0,0.2),0_0_1px_rgba(0,0,0,0.15)] transition-all duration-200 ${
          checked ? "left-[18px] dark:bg-neutral-900" : "left-[2px]"
        }`}
      />
    </button>
  );
}
