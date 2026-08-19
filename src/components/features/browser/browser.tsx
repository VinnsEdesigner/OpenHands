import { BrowserViewport } from "./browser-viewport";
import { BrowserChromeBar } from "./browser-chrome-bar";
import { EmptyBrowserMessage } from "./empty-browser-message";
import { useBrowserStore } from "#/stores/browser-store";

export function BrowserPanel() {
  const { url, screenshotSrc } = useBrowserStore();
  const hasPage = Boolean(screenshotSrc);

  const imgSrc = screenshotSrc?.startsWith("data:image/png;base64,")
    ? screenshotSrc
    : `data:image/png;base64,${screenshotSrc ?? ""}`;

  return (
    <div className="flex h-full min-h-0 w-full flex-col text-[var(--oh-muted)]">
      <BrowserChromeBar url={url} hasPage={hasPage} />
      {screenshotSrc ? (
        <BrowserViewport src={imgSrc} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-hide bg-[var(--oh-surface)]">
          <EmptyBrowserMessage />
        </div>
      )}
    </div>
  );
}
