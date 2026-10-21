/**
 * Keep a runtime error from destroying the window.
 *
 * The capture overlay is one full-screen view; replacing `#root` with an error
 * page mid-session tears the whole surface down, which reads to the user as
 * "the screenshot UI closed itself". A live app must survive its own errors, so
 * only a failure *before React mounts* may blank the window.
 */
let mounted = false;

export function installBootGuard() {
  window.addEventListener("error", (e) => {
    (window as unknown as { __bootError?: string }).__bootError = String(e.message);
    if (mounted) {
      console.error("uncaught error", e.error ?? e.message);
      return;
    }
    const el = document.getElementById("root");
    if (el) {
      el.innerHTML = `<pre style="color:#fff;background:#b91c1c;padding:12px;margin:0;font-size:12px;white-space:pre-wrap">boot error: ${e.message}</pre>`;
    }
  });
}

/** Stop the boot fallback from blanking the window; call once React has mounted. */
export function markMounted() {
  mounted = true;
}
