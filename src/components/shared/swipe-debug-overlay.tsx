/* eslint-disable i18next/no-literal-string */
import { useEffect, useRef, useState } from "react";

/**
 * Temporary on-device diagnostics for the edge-swipe gestures.
 *
 * Activate by appending `#swipe-debug` to the conversation URL (e.g.
 * `/conversations/<id>?backend=…&org=…#swipe-debug`). The hash is purely
 * client-side — never sent to the server, and it coexists with the
 * `backend`/`org` query params the canvas needs, so it won't redirect to "/"
 * the way a `?swipe-debug=1` query param did.
 *
 * Mirrors `useSwipeGesture`: document-level pointer listeners + an edge zone
 * + axis-lock, showing the raw truth about pointer delivery on-device so we
 * can localize which stage fails (down missing / pointercancel / no axis /
 * never reaches threshold / commits but action fails).
 *
 * The overlay does NOT preventDefault or capture, so it observes without
 * interfering. Diagnostic only — remove once the gesture is verified working.
 *
 * All transient gesture state (start coords, axis, pointer id, move count)
 * lives in refs and the listeners are bound ONCE on mount — never re-bound
 * on state changes. An earlier version re-ran the effect on each state
 * change, tearing down and rebuilding listeners mid-gesture so almost every
 * event was missed (only `vw`, read at render time, ever updated).
 */

const DEBUG_HASH = "swipe-debug";
const EDGE_WIDTH = 36;
const SLOP = 8;
const THRESHOLD = 45;
const LOG_MAX = 6;

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
  log: string[];
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
  log: [],
};

export function SwipeDebugOverlay() {
  const [state, setState] = useState<DebugState>(INITIAL);
  const [active, setActive] = useState(
    () =>
      typeof window !== "undefined" &&
      window.location.hash === `#${DEBUG_HASH}`,
  );
  const [vw, setVw] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 0,
  );

  // Transient gesture state in refs so the once-bound listeners always read
  // fresh values without re-binding.
  const startRef = useRef({ x: 0, y: 0 });
  const axisRef = useRef<string>("");
  const idRef = useRef<number | null>(null);
  const movesRef = useRef(0);

  const pushLog = (prev: string[], entry: string): string[] => {
    const next = [...prev, entry];
    if (next.length > LOG_MAX) next.shift();
    return next;
  };

  // Track hash changes (user can toggle the overlay by editing the hash).
  useEffect(() => {
    const sync = () => setActive(window.location.hash === `#${DEBUG_HASH}`);
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  // Keep viewport width fresh.
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Bind the pointer listeners ONCE (only when active). Reads/writes refs so
  // it never needs to re-bind mid-gesture.
  useEffect(() => {
    if (!active) return undefined;

    const onDown = (e: PointerEvent) => {
      const edge =
        e.clientX <= EDGE_WIDTH
          ? "LEFT"
          : e.clientX >= window.innerWidth - EDGE_WIDTH
            ? "RIGHT"
            : "no";
      startRef.current = { x: e.clientX, y: e.clientY };
      axisRef.current = "";
      idRef.current = e.pointerId;
      movesRef.current = 0;
      setState({
        ...INITIAL,
        log: [],
        lastEvent: "pointerdown",
        pointerType: e.pointerType,
        startX: e.clientX,
        startY: e.clientY,
        curX: e.clientX,
        curY: e.clientY,
        inEdgeZone: edge,
      });
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== idRef.current) return;
      const { x: sx, y: sy } = startRef.current;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);
      if (!axisRef.current && Math.max(adx, ady) >= SLOP) {
        axisRef.current = adx >= ady ? "HORIZ" : "VERT";
      }
      const axis = axisRef.current;
      const dir = dx < 0 ? "left" : "right";
      const committed =
        axis === "HORIZ" && adx >= THRESHOLD ? `✅ ${dir}` : "—";
      movesRef.current += 1;
      setState((s) => ({
        ...s,
        lastEvent: "pointermove",
        curX: e.clientX,
        curY: e.clientY,
        axis: axis || "—",
        travel: adx,
        committed,
        moveCount: movesRef.current,
        log: pushLog(s.log, `mv ${adx | 0},${ady | 0} ${axis || "?"}`),
      }));
    };

    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== idRef.current) return;
      setState((s) => ({
        ...s,
        lastEvent: "pointerup",
        curX: e.clientX,
        curY: e.clientY,
        log: pushLog(s.log, "up"),
      }));
      idRef.current = null;
    };

    const onCancel = (e: PointerEvent) => {
      if (e.pointerId !== idRef.current) return;
      setState((s) => ({
        ...s,
        lastEvent: "pointercancel",
        cancelled: true,
        log: pushLog(s.log, "CANCEL"),
      }));
      idRef.current = null;
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
  }, [active]);

  if (!active) return null;

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
    ["vw", vw],
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
        lineHeight: 1.45,
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
      <div
        style={{
          marginTop: 4,
          paddingTop: 4,
          borderTop: "1px solid rgba(0,255,0,0.25)",
          opacity: 0.85,
        }}
      >
        {state.log.length === 0 ? (
          <span style={{ opacity: 0.5 }}>no events yet</span>
        ) : (
          state.log.map((l, i) => <div key={`${i}-${l}`}>{l}</div>)
        )}
      </div>
    </div>
  );
}
