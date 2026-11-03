/**
 * 识别方式选择 — the OCR engine picker for the 提取文字 tab.
 *
 * Mirrors the reference app's picker: one card per engine (云端 / 系统 /
 * PP-OCRV6 / Qota-OCR), the current engine highlighted with a check and a
 * disabled「当前使用」tag, model cards with a cloud 下载 that streams progress,
 * and the footnote that switching never deletes downloaded models.
 */

import { type OcrProviderId, type OcrProviderInfo } from "../lib/ipc";

/** Live download for one provider, mirrored from `ocr://download` events. */
export type OcrDownloadState = {
  provider: OcrProviderId;
  filename: string;
  downloaded: number;
  total: number | null;
};

type Props = {
  providers: OcrProviderInfo[];
  download: OcrDownloadState | null;
  downloadError: string | null;
  onSwitch: (id: OcrProviderId) => void;
  onDownload: (id: OcrProviderId) => void;
  onBack: () => void;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function CheckCircleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" fill="currentColor" />
      <path
        d="M5.4 8.2l1.7 1.7 3.5-3.8"
        stroke="#fff"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 2.5v7m0 0l-2.6-2.6M8 9.5l2.6-2.6M3.5 12.5h9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function OcrProviderPicker({
  providers,
  download,
  downloadError,
  onSwitch,
  onDownload,
  onBack,
}: Props) {
  // Model cards only exist where the models can run; the backend already
  // marks those unavailable, so the picker never shows a dead card.
  const visible = providers.filter((p) => p.available);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3.5 py-3">
      <button
        className="-ml-1.5 self-start rounded-lg px-1.5 py-0.5 text-mini color-primary-600 transition hover:bg-primary-500/8"
        onClick={onBack}
      >
        ‹ 返回提取结果
      </button>

      {visible.map((provider) => {
        const isModel = provider.id === "ppocr" || provider.id === "qota";
        const downloading =
          download !== null &&
          download.provider === provider.id &&
          !provider.downloaded;
        const percent =
          downloading && download.total !== null && download.total > 0
            ? Math.min(100, Math.round((download.downloaded / download.total) * 100))
            : null;

        return (
          <div key={provider.id}>
            <div
              className={`flex items-center gap-3 rounded-xl border px-3.5 py-3 transition ${
                provider.current
                  ? "border-primary-500/60 bg-primary-500/6"
                  : "border-line hover:border-primary-500/35"
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {provider.current && (
                    <span className="flex-none color-primary-600">
                      <CheckCircleIcon />
                    </span>
                  )}
                  <span className="truncate text-[13px] font-500">{provider.title}</span>
                  {provider.id === "qota" && (
                    <span className="flex-none rounded bg-primary-500/10 px-1.5 py-0.5 text-mini font-500 color-primary-600">
                      推荐
                    </span>
                  )}
                </div>
                <div className="mt-1 truncate text-mini color-ink-dim">
                  {provider.subtitle}
                  {provider.sizeLabel !== null && ` · ${provider.sizeLabel}`}
                </div>

                {downloading && (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-1 w-full max-w-56 overflow-hidden rounded-full bg-surface-alt">
                      <div
                        className="h-full rounded-full bg-primary-500 transition-[width]"
                        style={{ width: percent === null ? "100%" : `${percent}%` }}
                      />
                    </div>
                    <span className="flex-none text-mini tabular-nums color-ink-dim">
                      {formatBytes(download.downloaded)}
                      {download.total !== null ? ` / ${formatBytes(download.total)}` : ""}
                    </span>
                  </div>
                )}
                {downloadError !== null && download?.provider === provider.id && (
                  <div className="mt-1.5 break-all text-mini text-error-600">{downloadError}</div>
                )}
              </div>

              {provider.current ? (
                <span className="flex-none rounded-lg bg-surface-alt px-2.5 py-1.5 text-mini color-ink-dim">
                  当前使用
                </span>
              ) : isModel && !provider.downloaded ? (
                <button
                  className="ai-headbtn flex flex-none items-center gap-1.5 color-primary-600"
                  disabled={downloading}
                  onClick={() => onDownload(provider.id)}
                >
                  {downloading ? (
                    <span className="tabular-nums">
                      {percent === null ? "下载中" : `${percent}%`}
                    </span>
                  ) : (
                    <>
                      <DownloadIcon />
                      下载
                    </>
                  )}
                </button>
              ) : (
                <button
                  className="ai-headbtn flex-none color-primary-600"
                  onClick={() => onSwitch(provider.id)}
                >
                  切换
                </button>
              )}
            </div>
          </div>
        );
      })}

      <div className="mt-1 px-0.5 text-mini leading-5 color-faint">
        云端 OCR 需要联网；切换识别方式不会删除已经下载的本地模型。
      </div>
    </div>
  );
}
