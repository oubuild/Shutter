/**
 * External destinations of the settings popover menu (推荐服务 / 反馈).
 *
 * Shutter has no marketing site, so the "官网" row points at the repository
 * and the second recommendation is the GitHub organisation. Opening goes
 * through the opener plugin with a browser fallback — the same contract
 * updater.ts uses for the release page, so no new permission is required.
 */

export const LINKS = {
  website: "https://github.com/oubuild/Shutter",
  github: "https://github.com/oubuild",
  feedback: "https://github.com/oubuild/Shutter/issues",
} as const;

export function openExternal(url: string): void {
  void import("@tauri-apps/plugin-opener")
    .then(({ openUrl }) => openUrl(url))
    .catch(() => window.open(url, "_blank", "noopener,noreferrer"));
}
