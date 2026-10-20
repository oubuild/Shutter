/**
 * Line icons for the settings pane.
 *
 * Hand-rolled 24px stroke glyphs rather than a dependency: the app ships five
 * windows and a handful of icons, and an icon package would outweigh all of
 * them. The visual contract is the same one the capture toolbar uses — 1.7px
 * stroke, round caps, `currentColor` — so the chrome reads as one family.
 */

import type { ReactNode } from "react";

type IconProps = {
  size?: number;
  className?: string;
};

function Glyph({ size = 16, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** The AI section mark: a sparkle pair, the usual shorthand for "assistant". */
export function IconSparkles(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M11 3.5l1.7 4.3L17 9.5l-4.3 1.7L11 15.5 9.3 11.2 5 9.5l4.3-1.7L11 3.5z" />
      <path d="M17.5 14l.9 2.2 2.1.8-2.1.8-.9 2.2-.9-2.2-2.1-.8 2.1-.8.9-2.2z" />
    </Glyph>
  );
}

/** Screenshot / save section mark. */
export function IconImage(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <circle cx="8.6" cy="10" r="1.6" />
      <path d="M3.6 17.2l4.7-4.4 3.4 3.1 2.8-2.5 5.9 5.1" />
    </Glyph>
  );
}

export function IconRefresh(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M20 11.5a8 8 0 1 0-2.6 6.4" />
      <path d="M20 4.5v6.9h-6.9" />
    </Glyph>
  );
}

export function IconEye(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M2.5 12S6.1 5.8 12 5.8 21.5 12 21.5 12 17.9 18.2 12 18.2 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.9" />
    </Glyph>
  );
}

export function IconEyeOff(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M9.9 6.2A9.9 9.9 0 0 1 12 6c5.9 0 9.5 6 9.5 6a17 17 0 0 1-2.7 3.4" />
      <path d="M6.3 7.9A16.4 16.4 0 0 0 2.5 12s3.6 6 9.5 6a9.6 9.6 0 0 0 3.6-.7" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="M4 3.5l16 17" />
    </Glyph>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4.5 12.7l4.7 4.8L19.5 6.8" />
    </Glyph>
  );
}

export function IconAlert(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.6v5.1" />
      <path d="M12 16.3v.1" />
    </Glyph>
  );
}

export function IconFolder(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.3l2 2.6h7.7A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-10z" />
    </Glyph>
  );
}

/** Credentials section mark. */
export function IconKey(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="8" cy="8" r="4.2" />
      <path d="M11 11l8.5 8.5" />
      <path d="M16.5 16.5l2-2" />
      <path d="M19 19l1.8-1.8" />
    </Glyph>
  );
}

/** Shortcuts section mark: a keyboard outline. */
export function IconKeyboard(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="2.5" y="6" width="19" height="12" rx="2.2" />
      <path d="M6 9.6v.1M9 9.6v.1M12 9.6v.1M15 9.6v.1M18 9.6v.1" />
      <path d="M7.5 14.4h9" />
    </Glyph>
  );
}
