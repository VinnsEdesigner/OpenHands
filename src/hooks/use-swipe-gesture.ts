import { useEffect, useRef, type RefObject } from "react";

/**
 * Minimum horizontal travel (px) before a touch is treated as a committed
 * swipe rather than a tap or incidental jitter. Tuned to be larger than a
 * typical tap-drift but small enough to feel responsive on a phone.
 */
const DEFAULT_THRESHOLD = 45;

/**
 * Movement (px) before the gesture's axis is locked. Below this we just
 * record the start and let the browser handle the touch; once total
 * movement exceeds this slop we decide whether the gesture is horizontal
 * (we claim it) or vertical (we abandon it so the browser scrolls). This
 * MUST be smaller than the browser's own touch-slop (~8–16px on most
 * platforms) so we get to call `preventDefault()` — and claim the gesture —
 * before the browser commits to a vertical pan and fires `touchcancel`.
 * Without this early claim, a real finger's inevitable first few px of
 * vertical drift lets the browser steal the gesture and the swipe never
 * fires.
 */
const AXIS_LOCK_SLOP = 8;

/**
 * Width (px) of the screen-edge zone from which an *opening* swipe must
 * start. Wide enough to register a deliberate edge drag from a fingertip
 * (or a phone with a case) without intercepting taps in the content body.
 */
const DEFAULT_EDGE_WIDTH = 36;

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
 * Detect a horizontal finger swipe and report its direction.
 *
 * This uses the axis-lock state machine that production touch UIs (Material
 * `SwipeableDrawer`, react-swipeable, iOS edge gestures) rely on:
 *
 *  1. `touchstart` records the origin (and, for `startEdge`, gates on the
 *     edge zone / scope).
 *  2. On the first `touchmove` whose total movement exceeds `AXIS_LOCK_SLOP`,
 *     the axis is locked: horizontal → the hook calls `preventDefault()` to
 *     claim the gesture from the browser and keeps tracking; vertical → the
 *     hook abandons so the browser scrolls normally.
 *  3. Once axis-locked horizontal, every subsequent `touchmove` is
 *     `preventDefault()`ed so the browser can't start a pan mid-gesture
 *     (this is what keeps a swipe alive through real-finger vertical drift).
 *  4. The swipe commits (`onSwipe` fires) when horizontal travel exceeds
 *     `threshold`; the action fires at most once per gesture.
 *
 * CRITICAL prerequisite: for the hook to receive horizontal `touchmove`
 * events at all, the touched scroll surface must have `touch-action: pan-y`
 * (or `none`). With the default `touch-action: auto` the browser consumes
 * horizontal panning itself and the listener never sees the moves. The
 * `.conversation-gesture-host` class (see `index.css`) applies `pan-y` to
 * the gesture surfaces — including nested scroll containers, since
 * `touch-action` is intersected up to the nearest scrolling element.
 *
 * Pointer/mouse events are intentionally not handled — this is a touch-only
 * gesture. Desktop users continue to use the toggle buttons and the resize
 * handle.
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
    let axis: "horizontal" | "vertical" | null = null;
    let committed = false;

    const handleTouchStart = (event: Event) => {
      if (!(event instanceof TouchEvent) || event.touches.length !== 1) {
        tracking = false;
        axis = null;
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
      axis = null;
      committed = false;
    };

    const handleTouchMove = (event: Event) => {
      if (!tracking || committed) return;
      if (!(event instanceof TouchEvent) || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);

      // Phase 1 — decide the axis once movement exceeds the slop. This is
      // the crucial early claim: we do it before the browser's own touch-slop
      // lets it commit to a vertical pan (which would fire `touchcancel` and
      // end our gesture). `preventDefault()` here tells the browser "I own
      // this pointer", so it stops panning and keeps sending us touchmove.
      if (axis === null) {
        if (Math.max(adx, ady) < AXIS_LOCK_SLOP) return;
        if (adx >= ady) {
          axis = "horizontal";
          if (event.cancelable) event.preventDefault();
        } else {
          // Dominantly vertical from the start → it's a scroll, not a swipe.
          // Don't preventDefault (let the browser pan) and stop tracking.
          axis = "vertical";
          tracking = false;
          return;
        }
      }

      // Axis locked horizontal — keep the browser out for the whole gesture.
      if (event.cancelable) event.preventDefault();
      if (axis !== "horizontal") return;

      if (adx < threshold) return;
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
      onSwipeRef.current(dir);
    };

    const handleTouchEnd = () => {
      tracking = false;
      axis = null;
      committed = false;
    };

    // `passive: false` on touchmove so preventDefault works (we call it at
    // axis-lock time, not just at commit); touchstart/touchend stay passive.
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
