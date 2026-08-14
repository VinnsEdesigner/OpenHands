/* eslint-disable i18next/no-literal-string */
import { useEffect, useRef, useState } from "react";

/**
 * Temporary on-device diagnostics for the edge-swipe gestures.
 *
 * Activate with the URL param `?swipe-debug=1` (e.g.
 * `/conversations/<id>?swipe-debug=1`). Renders a small fixed panel that
 * mirrors what `useSwipeGesture` does — attaches its own document-level
 * pointer listeners with an edge zone + axis-lock — and shows the raw truth
 * about pointer delivery on the device. This isolates WHICH stage fails:
 *
 *  - "down" never appears        → pointerdown doesn't reach document at all
 *                                   (OS / browser is consuming the touch).
 *  - "down" shows then "cancel"  → the OS (e.g. Android back-gesture nav)
 *                                   took over and cancelled the pointer.
 *  - "down" + moves but no axis  → movement under the 8px slop, or vertical.
 *  - "axis=H + travel" but no ✅   → never reached the 45px threshold.
 *  - "✅ commit" shows but panel   → the gesture fires but the open action /
 *   doesn't open                    gating is the bug (not detection).
 *
 * The overlay does NOT call preventDefault or capture, so it observes
 * without interfering. It's a diagnostic only — remove once the gesture is
 * verified working on the target device.
 */

const EDGE_WIDTH = 36;
const SLOP = 8;
const THRESHOLD = 45;

interface DebugState {
  lastEvent: string;
  pointerType: string;
  startX: number;
  startY: number;
  curX: number;
  curY: number;
  axis: string;
  travel: number;
  inEdgeZone: string;
  committed: string;
  moveCount: number;
  cancelled: boolean;
}

const INITIAL: DebugState = {
  lastEvent: "—",
  pointerType: "—",
  startX: 0,
  startY: 0,
  curX: 0,
  curY: 0,
  axis: "—",
  travel: 0,
  inEdgeZone: "—",
  committed: "—",
  moveCount: 0,
  cancelled: false,
};

export function SwipeDebugOverlay() {
  const [state, setState] = useState<DebugState>(INITIAL);
  const trackingId = useRef<number | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("swipe-debug") !== "1") return undefined;

    const onDown = (e: PointerEvent) => {
      const edge =
        e.clientX <= EDGE_WIDTH
          ? "LEFT"
          : e.clientX >= window.innerWidth - EDGE_WIDTH
            ? "RIGHT"
            : "no";
      trackingId.current = e.pointerId;
      setState({
        ...INITIAL,
        lastEvent: "pointerdown",
        pointerType: e.pointerType,
        startX: e.clientX,
        startY: e.clientY,
        curX: e.clientX,
        curY: e.clientY,
        inEdgeZone: edge,
        moveCount: 0,
      });
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== trackingId.current) return;
      const dx = e.clientX - state.startX;
      const dy = e.clientY - state.startY;
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);
      let axis = state.axis;
      if (axis === "—" && Math.max(adx, ady) >= SLOP) {
        axis = adx >= ady ? "HORIZ" : "VERT";
      }
      const dir = dx < 0 ? "left" : "right";
      const committed =
        axis === "HORIZ" && adx >= THRESHOLD ? `✅ ${dir}` : "—";
      setState((s) => ({
        ...s,
        lastEvent: "pointermove",
        curX: e.clientX,
        curY: e.clientY,
        axis,
        travel: adx,
        committed,
        moveCount: s.moveCount + 1,
      }));
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== trackingId.current) return;
      setState((s) => ({
        ...s,
        lastEvent: "pointerup",
        curX: e.clientX,
        curY: e.clientY,
      }));
      trackingId.current = null;
    };
    const onCancel = (e: PointerEvent) => {
      if (e.pointerId !== trackingId.current) return;
      setState((s) => ({
        ...s,
        lastEvent: "pointercancel",
        cancelled: true,
      }));
      trackingId.current = null;
    };

    document.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerup", onUp, { passive: true });
    document.addEventListener("pointercancel", onCancel, { passive: true });

    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
    };
    // Re-bind when start coords change so onMove sees fresh start values.
  }, [state.startX, state.startY, state.axis]);

  const params = new URLSearchParams(window.location.search);
  if (params.get("swipe-debug") !== "1") return null;

  const rows: Array<[string, string | number]> = [
    ["event", state.lastEvent],
    ["pointerType", state.pointerType],
    ["edgeZone", state.inEdgeZone],
    ["start", `${state.startX | 0},${state.startY | 0}`],
    ["cur", `${state.curX | 0},${state.curY | 0}`],
    ["axis", state.axis],
    ["travel|x", state.travel | 0],
    ["moves", state.moveCount],
    ["commit", state.committed],
    ["vw", window.innerWidth],
  ];

  return (
    <div
      style={{
        position: "fixed",
        bottom: 8,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 9999,
        maxWidth: "92vw",
        padding: "8px 10px",
        borderRadius: 8,
        background: "rgba(0,0,0,0.88)",
        color: "#0f0",
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 1.5,
        pointerEvents: "none",
        boxShadow: "0 2px 12px rgba(0,0,0,0.4)",
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 4 }}>
        SWIPE DEBUG {state.cancelled ? "· CANCELLED ❌" : ""}
      </div>
      {rows.map(([label, value]) => (
        <div
          key={label}
          style={{ display: "flex", justifyContent: "space-between", gap: 8 }}
        >
          <span style={{ opacity: 0.7 }}>{label}</span>
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}
