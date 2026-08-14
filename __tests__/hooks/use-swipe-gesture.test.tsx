import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useSwipeGesture } from "#/hooks/use-swipe-gesture";

/**
 * Dispatch a PointerEvent on the given target. The hook is built on Pointer
 * Events (pointerdown/move/up/cancel) which fire uniformly for mouse, touch,
 * and pen — so the tests use `pointerType: "touch"` to model a finger and
 * `pointerType: "mouse"` to model a desktop drag. jsdom supports
 * `PointerEvent`. `setPointerCapture`/`releasePointerCapture` are stubbed
 * on Element.prototype so the capture path doesn't throw.
 */
function dispatchPointer(
  target: Document | HTMLElement,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  clientX: number,
  clientY: number,
  pointerId = 1,
  pointerType: "touch" | "mouse" = "touch",
): void {
  const eventTarget = target === document ? document.body : (target as Node);
  const event = new PointerEvent(type, {
    pointerId,
    pointerType,
    clientX,
    clientY,
    cancelable: true,
    bubbles: true,
  });
  // jsdom doesn't set `target` for document-dispatched events the way real
  // browsers do; set it explicitly so the hook's scope check sees the body.
  Object.defineProperty(event, "target", {
    value: eventTarget,
    configurable: true,
  });
  target.dispatchEvent(event);
}

describe("useSwipeGesture", () => {
  let originalInnerWidth: number;
  let originalSetPointerCapture: typeof Element.prototype.setPointerCapture;
  let originalReleasePointerCapture: typeof Element.prototype.releasePointerCapture;

  beforeEach(() => {
    originalInnerWidth = window.innerWidth;
    // A wide viewport so the right-edge zone math is predictable.
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 1024,
    });
    // jsdom doesn't implement pointer capture; stub them as no-ops so the
    // hook's capture/release calls don't throw during tests.
    originalSetPointerCapture = Element.prototype.setPointerCapture;
    originalReleasePointerCapture = Element.prototype.releasePointerCapture;
    Element.prototype.setPointerCapture = function setPointerCapture() {};
    Element.prototype.releasePointerCapture = function releasePointerCapture() {};
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: originalInnerWidth,
    });
    Element.prototype.setPointerCapture = originalSetPointerCapture;
    Element.prototype.releasePointerCapture = originalReleasePointerCapture;
  });

  it("fires onSwipe('right') for a committed rightward swipe from the left edge", () => {
    const onSwipe = vi.fn();
    renderHook(() =>
      useSwipeGesture({
        direction: "right",
        startEdge: "left",
        onSwipe,
      }),
    );

    // Start near the left edge (within the default 36px zone).
    dispatchPointer(document, "pointerdown", 10, 100);
    // Move rightward past the threshold.
    dispatchPointer(document, "pointermove", 90, 100);
    dispatchPointer(document, "pointerup", 90, 100);

    expect(onSwipe).toHaveBeenCalledWith("right");
  });

  it("does not fire when the touch starts outside the edge zone", () => {
    const onSwipe = vi.fn();
    renderHook(() =>
      useSwipeGesture({
        direction: "right",
        startEdge: "left",
        onSwipe,
      }),
    );

    // Start in the middle of the screen — outside the left edge zone.
    dispatchPointer(document, "pointerdown", 500, 100);
    dispatchPointer(document, "pointermove", 700, 100);
    dispatchPointer(document, "pointerup", 700, 100);

    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("fires onSwipe('left') for a leftward swipe from the right edge", () => {
    const onSwipe = vi.fn();
    renderHook(() =>
      useSwipeGesture({
        direction: "left",
        startEdge: "right",
        onSwipe,
      }),
    );

    // innerWidth=1024; right edge zone is the rightmost 36px, so start at 1020.
    dispatchPointer(document, "pointerdown", 1020, 100);
    dispatchPointer(document, "pointermove", 900, 100);
    dispatchPointer(document, "pointerup", 900, 100);

    expect(onSwipe).toHaveBeenCalledWith("left");
  });

  it("does not hijack vertical scrolls (dominantly vertical movement)", () => {
    const onSwipe = vi.fn();
    renderHook(() =>
      useSwipeGesture({
        direction: "both",
        onSwipe,
      }),
    );

    // Move downward far more than sideways — a vertical scroll, not a swipe.
    dispatchPointer(document, "pointerdown", 100, 100);
    dispatchPointer(document, "pointermove", 110, 400);
    dispatchPointer(document, "pointerup", 110, 400);

    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("does not fire for a swipe below the threshold distance", () => {
    const onSwipe = vi.fn();
    renderHook(() =>
      useSwipeGesture({
        direction: "right",
        onSwipe,
      }),
    );

    dispatchPointer(document, "pointerdown", 100, 100);
    // Only 30px rightward — under the default 45px threshold.
    dispatchPointer(document, "pointermove", 130, 100);
    dispatchPointer(document, "pointerup", 130, 100);

    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("respects the direction filter (ignores the wrong direction)", () => {
    const onSwipe = vi.fn();
    renderHook(() =>
      useSwipeGesture({
        direction: "left",
        onSwipe,
      }),
    );

    // A rightward swipe should not fire when direction="left".
    dispatchPointer(document, "pointerdown", 100, 100);
    dispatchPointer(document, "pointermove", 200, 100);
    dispatchPointer(document, "pointerup", 200, 100);

    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("does not attach listeners when enabled is false", () => {
    const onSwipe = vi.fn();
    renderHook(() =>
      useSwipeGesture({
        direction: "right",
        startEdge: "left",
        onSwipe,
        enabled: false,
      }),
    );

    dispatchPointer(document, "pointerdown", 10, 100);
    dispatchPointer(document, "pointermove", 90, 100);
    dispatchPointer(document, "pointerup", 90, 100);

    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("scopes to a target element and ignores touches starting outside it", () => {
    const onSwipe = vi.fn();
    const panel = document.createElement("div");
    document.body.appendChild(panel);

    renderHook(() =>
      useSwipeGesture({
        direction: "right",
        targetRef: { current: panel },
        onSwipe,
      }),
    );

    // Touch starting on the document body (outside the panel) — ignored.
    dispatchPointer(document, "pointerdown", 100, 100);
    dispatchPointer(document, "pointermove", 200, 100);
    dispatchPointer(document, "pointerup", 200, 100);
    expect(onSwipe).not.toHaveBeenCalled();

    // Touch starting inside the panel — fires (pointerType defaults to touch,
    // which close gestures accept).
    const touchTarget = document.createElement("div");
    panel.appendChild(touchTarget);
    dispatchPointer(panel, "pointerdown", 100, 100);
    dispatchPointer(panel, "pointermove", 200, 100);
    dispatchPointer(panel, "pointerup", 200, 100);

    expect(onSwipe).toHaveBeenCalledWith("right");

    document.body.removeChild(panel);
  });

  it("excludes mouse pointers from scoped (close) gestures", () => {
    // A mouse drag inside a panel must not hijack the gesture (desktop text
    // selection / clicks stay native). Only touch/pen close.
    const onSwipe = vi.fn();
    const panel = document.createElement("div");
    document.body.appendChild(panel);

    renderHook(() =>
      useSwipeGesture({
        direction: "right",
        targetRef: { current: panel },
        onSwipe,
      }),
    );

    dispatchPointer(panel, "pointerdown", 100, 100, 1, "mouse");
    dispatchPointer(panel, "pointermove", 200, 100, 1, "mouse");
    dispatchPointer(panel, "pointerup", 200, 100, 1, "mouse");

    expect(onSwipe).not.toHaveBeenCalled();

    document.body.removeChild(panel);
  });

  it("accepts mouse pointers on document-level (open) gestures", () => {
    // Open gestures accept all pointer types so a desktop trackpad/mouse drag
    // from a screen edge opens the panel too.
    const onSwipe = vi.fn();
    renderHook(() =>
      useSwipeGesture({
        direction: "right",
        startEdge: "left",
        onSwipe,
      }),
    );

    dispatchPointer(document, "pointerdown", 10, 100, 1, "mouse");
    dispatchPointer(document, "pointermove", 90, 100, 1, "mouse");
    dispatchPointer(document, "pointerup", 90, 100, 1, "mouse");

    expect(onSwipe).toHaveBeenCalledWith("right");
  });

  it("cleans up listeners on unmount (no fire after unmount)", () => {
    const onSwipe = vi.fn();
    const { unmount } = renderHook(() =>
      useSwipeGesture({
        direction: "right",
        startEdge: "left",
        onSwipe,
      }),
    );

    unmount();

    dispatchPointer(document, "pointerdown", 10, 100);
    dispatchPointer(document, "pointermove", 90, 100);
    dispatchPointer(document, "pointerup", 90, 100);

    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("only fires once per gesture (not on every move after commit)", () => {
    const onSwipe = vi.fn();
    renderHook(() =>
      useSwipeGesture({
        direction: "right",
        onSwipe,
      }),
    );

    dispatchPointer(document, "pointerdown", 100, 100);
    dispatchPointer(document, "pointermove", 200, 100); // commits
    dispatchPointer(document, "pointermove", 300, 100); // already committed
    dispatchPointer(document, "pointermove", 400, 100); // already committed
    dispatchPointer(document, "pointerup", 400, 100);

    expect(onSwipe).toHaveBeenCalledTimes(1);
  });

  it("commits a swipe with moderate vertical drift (real-finger tolerance)", () => {
    const onSwipe = vi.fn();
    renderHook(() =>
      useSwipeGesture({
        direction: "right",
        onSwipe,
      }),
    );

    // Start, drift down a bit, then go mostly horizontal past the threshold.
    // Once |dx| > |dy| and past slop the axis locks horizontal and commits
    // when |dx| exceeds the threshold.
    dispatchPointer(document, "pointerdown", 100, 100);
    dispatchPointer(document, "pointermove", 150, 145); // 50px x, 45px y — not yet
    dispatchPointer(document, "pointermove", 170, 155); // 70px x, 55px y — commits
    dispatchPointer(document, "pointerup", 170, 155);

    expect(onSwipe).toHaveBeenCalledWith("right");
  });

  it("requires the touch to start within the edge zone for startEdge gestures", () => {
    const onSwipe = vi.fn();
    renderHook(() =>
      useSwipeGesture({
        direction: "right",
        startEdge: "left",
        edgeWidth: 36,
        onSwipe,
      }),
    );

    // Start just outside the 36px left-edge zone.
    dispatchPointer(document, "pointerdown", 40, 100);
    dispatchPointer(document, "pointermove", 150, 100);
    dispatchPointer(document, "pointerup", 150, 100);

    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("locks the axis early and survives vertical drift after a horizontal start", () => {
    // Models the real-finger failure that made the old hook dead: the first
    // move is horizontal enough to lock the axis, then subsequent moves
    // drift vertically while still progressing horizontally. The axis lock
    // must keep the gesture alive so it commits.
    const onSwipe = vi.fn();
    renderHook(() =>
      useSwipeGesture({ direction: "right", onSwipe }),
    );

    dispatchPointer(document, "pointerdown", 100, 100);
    // 20px right, 5px down — past slop, horizontal-dominant → axis locks.
    dispatchPointer(document, "pointermove", 120, 105);
    // Continue right but drift down more than sideways — still commits
    // because the axis is already locked horizontal.
    dispatchPointer(document, "pointermove", 130, 160); // dx=30, dy=60
    dispatchPointer(document, "pointermove", 160, 165); // dx=60 → past threshold
    dispatchPointer(document, "pointerup", 160, 165);

    expect(onSwipe).toHaveBeenCalledWith("right");
  });

  it("abandons a gesture whose first movement is dominantly vertical", () => {
    // A vertical-start touch is a scroll, not a swipe: the hook must abandon
    // it (and NOT preventDefault) so the browser pans normally.
    const onSwipe = vi.fn();
    renderHook(() =>
      useSwipeGesture({ direction: "both", onSwipe }),
    );

    dispatchPointer(document, "pointerdown", 100, 100);
    // 5px right, 30px down — past slop, vertical-dominant → abandon.
    dispatchPointer(document, "pointermove", 105, 130);
    // Even if the finger then swings sideways, the gesture was abandoned.
    dispatchPointer(document, "pointermove", 200, 130);
    dispatchPointer(document, "pointerup", 200, 130);

    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("does not commit before the threshold even after axis lock", () => {
    const onSwipe = vi.fn();
    renderHook(() =>
      useSwipeGesture({ direction: "right", onSwipe }),
    );

    dispatchPointer(document, "pointerdown", 100, 100);
    // Past slop, horizontal → axis locks, but only 20px < 45 threshold.
    dispatchPointer(document, "pointermove", 120, 100);
    dispatchPointer(document, "pointerup", 120, 100);

    expect(onSwipe).not.toHaveBeenCalled();
  });
});
