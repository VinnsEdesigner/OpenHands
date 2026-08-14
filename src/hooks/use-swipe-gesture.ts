import { useEffect, useRef, type RefObject } from "react";

/**
 * Minimum horizontal travel (px) before a touch is treated as a committed
 * swipe rather than a tap or incidental jitter. Tuned to be larger than a
 * typical tap-drift but small enough to feel responsive on a phone.
 */
const DEFAULT_THRESHOLD = 60;

/**
 * How much the horizontal travel must exceed the vertical travel for the
 * gesture to count as a horizontal swipe. Prevents hijacking vertical
 * scrolls: a mostly-downward drag never fires a swipe even if it drifts
 * sideways past the threshold.
 */
const HORIZONTAL_DOMINANCE = 1.5;

/**
 * Width (px) of the screen-edge zone from which an *opening* swipe must
 * start. Kept narrow so taps/scrolls in the body of the content area are
 * never intercepted — only a deliberate drag that begins at the very edge
 * opens a panel.
 */
const DEFAULT_EDGE_WIDTH = 28;

export type SwipeDirection = "left" | "right";

export interface UseSwipeGestureOptions {
  /**
   * Direction(s) to detect. `"left"` fires `onSwipe("left")` for a
   * leftward drag, `"right"` for rightward, `"both"` for either.
   */
  direction?: "left" | "right" | "both";
  /**
   * When set, the touchstart must begin within this many px of the given
   * screen edge for the swipe to fire. Use `"left"` for an open-from-left
   * gesture, `"right"` for open-from-right. Omit to allow the swipe to start
   * anywhere on the element (useful for close gestures on a panel body).
   */
  startEdge?: "left" | "right";
  /** Edge zone width in px (only used when `startEdge` is set). */
  edgeWidth?: number;
  /** Minimum horizontal travel in px to commit a swipe. */
  threshold?: number;
  /** Called with the committed swipe direction. */
  onSwipe: (direction: SwipeDirection) => void;
  /** When false, the hook attaches no listeners. Defaults to true. */
  enabled?: boolean;
  /**
   * Element to scope the gesture to. When omitted, listeners attach to the
   * `document` (so the gesture works regardless of which child the touch
   * lands on — used for edge-to-open gestures). When provided, the touchstart
   * must begin inside this element (used for swipe-to-close on a specific
   * panel, so a rightward swipe in the chat body doesn't close the panel).
   */
  targetRef?: RefObject<HTMLElement | null>;
}

/**
 * Detect a horizontal finger swipe and report its direction. The hook
 * attaches native `touchstart` / `touchmove` / `touchend` listeners to the
 * document (so it works regardless of which child element the finger lands
 * on) and only fires when:
 *
 *  - the gesture is dominantly horizontal (vertical scrolls are never
 *    hijacked),
 *  - the horizontal travel exceeds `threshold`,
 *  - and, when `startEdge` is set, the touch began within `edgeWidth` px of
 *    that screen edge.
 *
 * This matches the native-touch convention already used in
 * `use-drag-resize.ts` and keeps the CSS-transition-driven panel animations
 * intact (the hook only dispatches an action; the existing transition does
 * the slide). A `preventDefault` is called only once a swipe has committed,
 * so taps and in-progress scrolls are not disrupted.
 *
 * Pointer/mouse events are intentionally not handled — this is a
 * touch-only gesture. Desktop users continue to use the toggle buttons and
 * the resize handle.
 */
export function useSwipeGesture({
  direction = "both",
  startEdge,
  edgeWidth = DEFAULT_EDGE_WIDTH,
  threshold = DEFAULT_THRESHOLD,
  onSwipe,
  enabled = true,
  targetRef,
}: UseSwipeGestureOptions): void {
  // Keep the latest callback in a ref so the effect does not re-bind
  // listeners on every render (and does not go stale if the parent
  // recreates the callback).
  const onSwipeRef = useRef(onSwipe);
  useEffect(() => {
    onSwipeRef.current = onSwipe;
  }, [onSwipe]);

  useEffect(() => {
    if (!enabled) return undefined;

    // Attach to the target element when provided (scoped close gestures),
    // otherwise to the document (edge-to-open gestures).
    const target: HTMLElement | Document = targetRef?.current ?? document;
    if (!target) return undefined;

    let startX = 0;
    let startY = 0;
    let tracking = false;
    let committed = false;

    const handleTouchStart = (event: Event) => {
      if (!(event instanceof TouchEvent) || event.touches.length !== 1) {
        tracking = false;
        return;
      }
      const touch = event.touches[0];
      if (startEdge === "left" && touch.clientX > edgeWidth) return;
      if (
        startEdge === "right" &&
        touch.clientX < window.innerWidth - edgeWidth
      )
        return;
      // When scoped to an element, ignore touches that began outside it
      // (the target's own children are inside it, so panel content swipes
      // still work — but a touch starting on the chat body is excluded).
      if (target !== document) {
        const node = event.target as Node | null;
        if (!node || !target.contains(node)) return;
      }
      startX = touch.clientX;
      startY = touch.clientY;
      tracking = true;
      committed = false;
    };

    const handleTouchMove = (event: Event) => {
      if (!tracking || committed) return;
      if (!(event instanceof TouchEvent) || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      // Only commit once the gesture is clearly horizontal so we never
      // steal a vertical scroll.
      if (Math.abs(dy) * HORIZONTAL_DOMINANCE >= Math.abs(dx)) return;
      if (Math.abs(dx) < threshold) return;
      const dir: SwipeDirection = dx < 0 ? "left" : "right";
      if (direction === "left" && dir !== "left") {
        tracking = false;
        return;
      }
      if (direction === "right" && dir !== "right") {
        tracking = false;
        return;
      }
      committed = true;
      // Prevent the browser from also scrolling/panning once we've taken
      // over the gesture.
      if (event.cancelable) event.preventDefault();
      onSwipeRef.current(dir);
    };

    const handleTouchEnd = () => {
      tracking = false;
      committed = false;
    };

    // `passive: false` on touchmove so preventDefault works after commit;
    // touchstart/touchend stay passive (we don't cancel them).
    target.addEventListener("touchstart", handleTouchStart, { passive: true });
    target.addEventListener("touchmove", handleTouchMove, { passive: false });
    target.addEventListener("touchend", handleTouchEnd, { passive: true });
    target.addEventListener("touchcancel", handleTouchEnd, { passive: true });

    return () => {
      target.removeEventListener("touchstart", handleTouchStart);
      target.removeEventListener("touchmove", handleTouchMove);
      target.removeEventListener("touchend", handleTouchEnd);
      target.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [direction, startEdge, edgeWidth, threshold, enabled, targetRef]);
}
