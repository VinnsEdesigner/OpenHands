import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useSwipeGesture } from "#/hooks/use-swipe-gesture";

/**
 * Minimal touch-like object the hook actually reads: clientX, clientY, and
 * (for scoped gestures) the `target` node. jsdom does not define `Touch`, so
 * we cast a plain object rather than constructing one.
 */
interface FakeTouch {
  clientX: number;
  clientY: number;
  target: EventTarget | null;
}

const makeTouch = (
  clientX: number,
  clientY: number,
  target: EventTarget | null,
): FakeTouch => ({ clientX, clientY, target });

/**
 * Dispatch a TouchEvent on the given target. jsdom supports `TouchEvent` but
 * not the `Touch` constructor, so we pass plain touch-like objects.
 */
function dispatchTouch(
  target: Document | HTMLElement,
  type: "touchstart" | "touchmove" | "touchend",
  clientX: number,
  clientY: number,
): void {
  const eventTarget = target === document ? document.body : (target as Node);
  const touch = makeTouch(clientX, clientY, eventTarget);
  const event = new TouchEvent(type, {
    touches: type === "touchend" ? [] : [touch as unknown as Touch],
    changedTouches: [touch as unknown as Touch],
    cancelable: true,
    bubbles: true,
  });
  // Set the event's target so the hook's `event.target` / `target.contains`
  // check sees the right node. jsdom's TouchEvent reuses the dispatched
  // target automatically via dispatchEvent, but we set it explicitly for
  // document-dispatched events where the body is the intended target.
  Object.defineProperty(event, "target", {
    value: eventTarget,
    configurable: true,
  });
  target.dispatchEvent(event);
}

describe("useSwipeGesture", () => {
  let originalInnerWidth: number;

  beforeEach(() => {
    originalInnerWidth = window.innerWidth;
    // A wide viewport so the right-edge zone math is predictable.
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: 1024,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: originalInnerWidth,
    });
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

    // Start near the left edge (within the default 28px zone).
    dispatchTouch(document, "touchstart", 10, 100);
    // Move rightward past the threshold.
    dispatchTouch(document, "touchmove", 90, 100);
    dispatchTouch(document, "touchend", 90, 100);

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
    dispatchTouch(document, "touchstart", 500, 100);
    dispatchTouch(document, "touchmove", 700, 100);
    dispatchTouch(document, "touchend", 700, 100);

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

    // innerWidth=1024; right edge zone is the rightmost 28px, so start at 1020.
    dispatchTouch(document, "touchstart", 1020, 100);
    dispatchTouch(document, "touchmove", 900, 100);
    dispatchTouch(document, "touchend", 900, 100);

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
    dispatchTouch(document, "touchstart", 100, 100);
    dispatchTouch(document, "touchmove", 110, 400);
    dispatchTouch(document, "touchend", 110, 400);

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

    dispatchTouch(document, "touchstart", 100, 100);
    // Only 30px rightward — under the default 60px threshold.
    dispatchTouch(document, "touchmove", 130, 100);
    dispatchTouch(document, "touchend", 130, 100);

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
    dispatchTouch(document, "touchstart", 100, 100);
    dispatchTouch(document, "touchmove", 200, 100);
    dispatchTouch(document, "touchend", 200, 100);

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

    dispatchTouch(document, "touchstart", 10, 100);
    dispatchTouch(document, "touchmove", 90, 100);
    dispatchTouch(document, "touchend", 90, 100);

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
    dispatchTouch(document, "touchstart", 100, 100);
    dispatchTouch(document, "touchmove", 200, 100);
    dispatchTouch(document, "touchend", 200, 100);
    expect(onSwipe).not.toHaveBeenCalled();

    // Touch starting inside the panel — fires.
    const touchTarget = document.createElement("div");
    panel.appendChild(touchTarget);
    const touch = makeTouch(100, 100, touchTarget);
    panel.dispatchEvent(
      new TouchEvent("touchstart", {
        touches: [touch as unknown as Touch],
        changedTouches: [touch as unknown as Touch],
        cancelable: true,
        bubbles: true,
      }),
    );
    const moveTouch = makeTouch(200, 100, touchTarget);
    panel.dispatchEvent(
      new TouchEvent("touchmove", {
        touches: [moveTouch as unknown as Touch],
        changedTouches: [moveTouch as unknown as Touch],
        cancelable: true,
        bubbles: true,
      }),
    );
    panel.dispatchEvent(
      new TouchEvent("touchend", {
        touches: [],
        changedTouches: [moveTouch as unknown as Touch],
        cancelable: true,
        bubbles: true,
      }),
    );

    expect(onSwipe).toHaveBeenCalledWith("right");

    document.body.removeChild(panel);
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

    dispatchTouch(document, "touchstart", 10, 100);
    dispatchTouch(document, "touchmove", 90, 100);
    dispatchTouch(document, "touchend", 90, 100);

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

    dispatchTouch(document, "touchstart", 100, 100);
    dispatchTouch(document, "touchmove", 200, 100); // commits
    dispatchTouch(document, "touchmove", 300, 100); // already committed
    dispatchTouch(document, "touchmove", 400, 100); // already committed
    dispatchTouch(document, "touchend", 400, 100);

    expect(onSwipe).toHaveBeenCalledTimes(1);
  });
});
