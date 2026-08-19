import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";

// Zoom presets: fit the image to the viewport (0.5, 0.75), real size (1.0),
// and zoomed-in for detail (1.5, 2.0, 3.0). The image is laid out at this
// factor of the viewport width; panning via scroll reveals the rest at high zoom.
const ZOOM_STEPS = [0.5, 0.75, 1.0, 1.5, 2.0, 3.0];

interface BrowserViewportProps {
  src: string;
}

/**
 * A zoomable, panning viewport for the browser screenshot.
 *
 * - On mobile, `fit-width` spans the panel edge-to-edge (fixes the "tiny at the
 *   top" problem where the raw img just rendered at its natural size).
 * - Zoom controls step by factor; scroll/pan reveals the region at high zoom.
 */
export function BrowserViewport({ src }: BrowserViewportProps) {
  const { t } = useTranslation("openhands");
  const [zoomIndex, setZoomIndex] = useState(2); // start at 1.0 = 100% width.
  const scrollerRef = useRef<HTMLDivElement>(null);

  const zoom = ZOOM_STEPS[zoomIndex];
  const zoomIn = () => setZoomIndex((i) => Math.min(i + 1, ZOOM_STEPS.length - 1));
  const zoomOut = () => setZoomIndex((i) => Math.max(i - 1, 0));

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--oh-surface)]">
      <div className="flex items-center justify-end gap-1 border-b border-[var(--oh-border)] px-2 py-1 text-xs">
        <button
          type="button"
          onClick={zoomOut}
          disabled={zoomIndex === 0}
          aria-label={t(I18nKey.BROWSER$ZOOM_OUT)}
          className="rounded px-2 py-0.5 disabled:opacity-40 hover:bg-[var(--oh-surface-hover)]"
        >
          −
        </button>
        <span className="min-w-[3ch] text-center tabular-nums">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={zoomIn}
          disabled={zoomIndex === ZOOM_STEPS.length - 1}
          aria-label={t(I18nKey.BROWSER$ZOOM_IN)}
          className="rounded px-2 py-0.5 disabled:opacity-40 hover:bg-[var(--oh-surface-hover)]"
        >
          +
        </button>
      </div>

      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-auto"
        role="region"
        aria-label={t(I18nKey.BROWSER$VIEWPORT)}
      >
        {/* The image fills the viewport horizontally at zoom × and pans via
            scroll when zoomed past 1.0. max-w-none lets it exceed the container
            width so the scroll region activates. */}
        <img
          src={src}
          className="block max-w-none origin-top"
          style={{ width: `${zoom * 100}%` }}
          alt={t(I18nKey.BROWSER$SCREENSHOT_ALT)}
          draggable={false}
        />
      </div>
    </div>
  );
}
