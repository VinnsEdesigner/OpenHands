// WebSocket streaming end-to-end test.
// Connects to the Cloud runtime sandbox WebSocket (exactly like the Canvas does),
// sends a message via REST, and captures StreamingDeltaEvents to confirm the
// free model streams token-by-token over WS.
// Uses Node 22's global WebSocket.

const CONV_ID = process.env.WST_CONV;
const SESSION_KEY = process.env.WST_SESSION_KEY;
const RUNTIME = process.env.WST_RUNTIME || "https://bfbwdgfskufugjjh.prod-runtime.all-hands.dev";

if (!CONV_ID || !SESSION_KEY) {
  console.error("WST_CONV and WST_SESSION_KEY are required");
  process.exit(1);
}

// The Canvas passes the session key as a query param and/or sends an auth
// message after open. We pass it as a query param (the agent-server reads it).
const wsUrl = `${RUNTIME.replace(/^http/, "ws")}/sockets/events/${CONV_ID}?session_api_key=${encodeURIComponent(SESSION_KEY)}`;
console.log("Connecting to runtime sandbox WS...");
console.log("  conv:", CONV_ID);

const ws = new WebSocket(wsUrl);

let deltaCount = 0;
let firstDeltaAt = 0;
let lastDeltaAt = 0;
const eventKinds = {};
let openedAt = 0;
const start = Date.now();

ws.addEventListener("open", () => {
  openedAt = Date.now();
  console.log(`[ws] OPEN (+${openedAt - start}ms)`);

  // Some agent-servers expect an auth frame; send it (harmless if ignored).
  ws.send(JSON.stringify({ type: "auth", session_api_key: SESSION_KEY }));

  // Trigger the agent by sending a message via REST POST /events.
  setTimeout(async () => {
    const body = JSON.stringify({
      message: "Write the numbers 1 through 10 separated by commas. Nothing else.",
      run: true,
    });
    console.log("[rest] sending message to trigger streaming...");
    try {
      const res = await fetch(`${RUNTIME}/api/conversations/${CONV_ID}/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Session-API-Key": SESSION_KEY,
        },
        body,
      });
      console.log("[rest] send status:", res.status, await res.text());
    } catch (e) {
      console.error("[rest] send error:", e.message);
    }
  }, 600);
});

ws.addEventListener("message", (msg) => {
  let evt;
  try {
    evt = JSON.parse(typeof msg.data === "string" ? msg.data : msg.data.toString());
  } catch {
    return;
  }

  const kind = evt.kind || evt.type || evt.event_type || "unknown";
  eventKinds[kind] = (eventKinds[kind] || 0) + 1;

  const isDelta =
    kind === "StreamingDeltaEvent" ||
    evt.event_type === "streaming_delta" ||
    (typeof kind === "string" && kind.toLowerCase().includes("delta"));

  if (isDelta) {
    deltaCount += 1;
    const now = Date.now();
    if (firstDeltaAt === 0) firstDeltaAt = now;
    lastDeltaAt = now;
    const content = evt.content || evt.delta || evt.text || "";
    if (deltaCount <= 8 || deltaCount % 20 === 0) process.stdout.write(content);
  } else if (kind === "MessageEvent" || kind === "message") {
    console.log(`\n[ws] MessageEvent (final) at deltaCount=${deltaCount}`);
  }
});

ws.addEventListener("error", (err) => {
  console.error("[ws] ERROR:", err.message || err);
  console.log("\nRESULT: FAIL — WebSocket error ❌");
  process.exit(1);
});

ws.addEventListener("close", (ev) => {
  console.log(`\n[ws] CLOSED code=${ev.code} reason=${ev.reason || ""}`);
  console.log("\n=== WS STREAMING TEST SUMMARY ===");
  console.log(`Conversation:             ${CONV_ID}`);
  console.log(`Model:                    openhands/glm-5.2 (free)`);
  console.log(`StreamingDeltaEvents received: ${deltaCount}`);
  if (deltaCount > 1) {
    const span = lastDeltaAt - firstDeltaAt;
    const rate = (deltaCount / (span / 1000)).toFixed(1);
    console.log(`First→last delta span:    ${span}ms`);
    console.log(`Delta rate:              ~${rate} deltas/sec`);
    console.log(`Inter-delta interval:    ~${(span / (deltaCount - 1)).toFixed(1)}ms`);
  }
  console.log(`Event kinds seen:        ${JSON.stringify(eventKinds)}`);
  console.log(
    `\nRESULT: ${deltaCount > 0 ? "PASS — streaming deltas flow over WebSocket ✅" : "FAIL — no deltas received ❌"}`,
  );
});

// Keep alive 45s then close.
setTimeout(() => {
  ws.close();
  setTimeout(() => process.exit(0), 500);
}, 45000);
