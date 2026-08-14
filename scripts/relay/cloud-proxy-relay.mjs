#!/usr/bin/env node
/**
 * OpenHands cloud-proxy relay.
 *
 * Re-implements the closed-source POST /api/cloud-proxy endpoint that was
 * removed from the OSS agent-server (PR #3326). The Canvas frontend's
 * CloudClient.requestThroughProxy() sends a request envelope to this path on
 * its own origin (same-origin, so no CORS), expecting the relay to forward
 * the call to the OpenHands Cloud and return the response.
 *
 * Envelope (from CloudClient.requestThroughProxy in the frontend bundle):
 *   POST /api/cloud-proxy
 *   Content-Type: application/json
 *   X-Session-API-Key: <optional proxy key>
 *   body: {
 *     host,               // e.g. "https://app.all-hands.dev"
 *     method,             // GET|POST|PATCH|PUT|DELETE
 *     path,               // e.g. "/api/v1/app-conversations/search"
 *     headers,            // upstream headers from the client
 *     body,               // request body (object or null)
 *     timeout_seconds?    // optional per-request timeout
 *   }
 *
 * The relay injects the Cloud API key (Authorization: Bearer) and X-Org-Id
 * server-side so the browser never holds the credential. Client-supplied
 * auth headers are preserved when present (the frontend sends them for
 * cookie/session-api-key modes), but Bearer is forced from the server key.
 *
 * Usage:
 *   CLOUD_API_KEY=<key> node cloud-proxy-relay.mjs
 *   CLOUD_API_KEY=<key> CLOUD_ORG_ID=<org-uuid> node cloud-proxy-relay.mjs
 *
 * Env:
 *   CLOUD_API_KEY   OpenHands Cloud API key (required)
 *   CLOUD_ORG_ID    Org UUID to send as X-Org-Id. When omitted, the relay
 *                   auto-derives it from the API key via GET /api/keys/current
 *                   at startup (same flow the Canvas frontend uses), so a user
 *                   can register a cloud backend with only an API key.
 *   CLOUD_HOST      Cloud host (default https://app.all-hands.dev)
 *   PORT            Relay listen port (default 18080)
 *   ALLOW_ORIGIN    CORS origin to allow for browser preflight (default *)
 *   PROXY_KEY       Optional X-Session-API-Key the relay itself requires
 *   AGENT_SERVER_URL  Upstream OSS agent-server for non-cloud-proxy /api routes.
 *                     When set, the relay reverse-proxies /api (except
 *                     /api/cloud-proxy) and /sockets, /server_info, /health,
 *                     /alive so it can sit directly in front of the Canvas.
 *                     Defaults to http://127.0.0.1:18000 for the local-mode
 *                     stack. Set to "" or "none" to DISABLE it for a pure-cloud
 *                     setup (no OSS agent server): agent-server prefixes then
 *                     return a clear 503 JSON instead of a misleading 502
 *                     (connection refused) against a non-existent upstream.
 *   STATIC_DIR      If set, serve the Canvas static build from this dir for
 *                     any non-API path (SPA fallback to index.html).
 */

import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFile, stat } from "node:fs/promises";
import { join, normalize } from "node:path";

const CLOUD_API_KEY = process.env.CLOUD_API_KEY;
// `let` because when unset we resolve it from /api/keys/current at startup.
let CLOUD_ORG_ID = process.env.CLOUD_ORG_ID || null;
const CLOUD_HOST = (
  process.env.CLOUD_HOST || "https://app.all-hands.dev"
).replace(/\/+$/, "");
const PORT = parseInt(process.env.PORT || "18080", 10);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";
const PROXY_KEY = process.env.PROXY_KEY || null;
// An explicit "" disables the local-agent proxy (pure-cloud mode). "none"/"off"
// are accepted as synonyms so the env var is never silently misread.
const RAW_AGENT_SERVER_URL =
  process.env.AGENT_SERVER_URL ?? "http://127.0.0.1:18000";
const AGENT_SERVER_URL =
  RAW_AGENT_SERVER_URL === "" ||
  /^(none|off|disabled)$/i.test(RAW_AGENT_SERVER_URL)
    ? null
    : RAW_AGENT_SERVER_URL.replace(/\/+$/, "");
const STATIC_DIR = process.env.STATIC_DIR || null;

if (!CLOUD_API_KEY) {
  console.error("CLOUD_API_KEY is required.");
  console.error("  CLOUD_API_KEY=<key> node cloud-proxy-relay.mjs");
  process.exit(1);
}

/**
 * Auto-derive the org ID from the API key, mirroring the Canvas frontend's
 * getCurrentCloudApiKey(): GET /api/keys/current with just the Bearer token
 * (no X-Org-Id) and read `org_id` from the response. The cloud resolves the
 * org from the key itself — one key binds to exactly one org.
 */
async function resolveOrgId() {
  if (CLOUD_ORG_ID) return CLOUD_ORG_ID;
  const url = new URL("/api/keys/current", CLOUD_HOST);
  try {
    const resp = await fetch(url, {
      headers: { authorization: `Bearer ${CLOUD_API_KEY}` },
    });
    if (!resp.ok) {
      throw new Error(
        `GET /api/keys/current returned ${resp.status} ${resp.statusText}`,
      );
    }
    const data = await resp.json();
    const orgId = data?.org_id || data?.bound_org_id;
    if (!orgId) {
      throw new Error("/api/keys/current did not return an org_id");
    }
    CLOUD_ORG_ID = orgId;
    console.log(
      `[cloud-proxy-relay] auto-derived org id from API key: ${orgId}`,
    );
    return CLOUD_ORG_ID;
  } catch (err) {
    console.error(
      "Failed to auto-derive CLOUD_ORG_ID from the API key:",
      err.message,
    );
    console.error(
      "Set CLOUD_ORG_ID explicitly, or provide a key bound to an org.",
    );
    process.exit(1);
  }
}

const CLOUD_PROXY_PATH = "/api/cloud-proxy";
// Prefixes forwarded to the OSS agent-server when AGENT_SERVER_URL is set,
// or to the cloud host in pure-cloud mode.
const AGENT_PREFIXES = [
  "/api",
  "/sockets",
  "/server_info",
  "/health",
  "/alive",
  "/openapi.json",
  "/docs",
  "/redoc",
  "/ready",
];

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  const headers = {
    "content-type": "application/json",
    "access-control-allow-origin": ALLOW_ORIGIN,
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(body);
}

// Cloud rate-limits bursty request bursts (e.g. the Canvas firing a dozen
// /api/v1/* calls on conversation open) with HTTP 429. Piping that straight
// through makes the frontend's EventService degrading fallback return an
// empty history page, so an already-finished conversation renders blank
// (the user message lands on a later page that never loads). We do three
// things: (1) cap concurrent upstream requests so the Canvas's open burst
// is paced under the cloud's limit instead of firing all at once, and
// (2) retry 429s with exponential backoff (honoring Retry-After when the
// server provides it) so a transient limit surfaces as a successful (if
// delayed) response rather than a silent empty render, and (3) retry
// transient network errors (ECONNRESET, ETIMEDOUT, socket hang-up) and 5xx
// upstream responses so a momentary blip on the cloud host or the
// Render↔cloud link is absorbed at the proxy layer instead of surfacing to
// the browser as a failed REST call — which the frontend would otherwise
// translate into a "Disconnected (check URL or network)" toast or a blank
// conversation. The relay is the single robust network-resilience layer.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Simple counting semaphore: bounds the number of in-flight cloud requests
// so the Canvas's conversation-open burst (history + sidebar + git + files)
// is spread out instead of tripping the cloud rate limiter. Tuned to stay
// under the observed per-key limit while keeping latency low; raise via
// CLOUD_MAX_CONCURRENCY if the upstream limit allows.
const MAX_CONCURRENCY = parseInt(process.env.CLOUD_MAX_CONCURRENCY || "3", 10);
let inflight = 0;
const waitQueue = [];
const acquire = () =>
  new Promise((resolve) => {
    if (inflight < MAX_CONCURRENCY) {
      inflight += 1;
      resolve();
    } else {
      waitQueue.push(resolve);
    }
  });
const release = () => {
  const next = waitQueue.shift();
  if (next) next();
  else inflight -= 1;
};

// Node network error codes that represent a transient connection failure
// (the upstream dropped the connection, the TCP probe timed out, a TLS
// renegotiation hiccuped, etc.) rather than a definitive "this can never
// work" result. Retrying these is strictly safe — the request is
// idempotent from the cloud's perspective (GET history / 429-retry) and the
// concurrency semaphore keeps us from hammering the upstream.
//
// The pure decision functions below live in `./retry-helpers.mjs` so they
// can be unit-tested without importing this module (which starts an HTTP
// server on load).
import {
  isRetriableStatus,
  backoffDelay,
  isTransientFetchError,
} from "./retry-helpers.mjs";

async function fetchUpstream(options) {
  const { url, method, reqHeaders, bodyBytes, timeoutMs } = options;
  const isTls = url.protocol === "https:";
  const lib = isTls ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const upstream = lib(
      {
        hostname: url.hostname,
        port: url.port || (isTls ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: reqHeaders,
      },
      (up) => {
        const chunks = [];
        up.on("data", (c) => chunks.push(c));
        up.on("end", () =>
          resolve({
            statusCode: up.statusCode || 502,
            headers: up.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    upstream.on("error", reject);
    upstream.setTimeout(timeoutMs, () =>
      upstream.destroy(new Error(`upstream timeout after ${timeoutMs}ms`)),
    );
    if (bodyBytes) upstream.write(bodyBytes);
    upstream.end();
  });
}

// Send the buffered upstream response back to the client. Reads the body so
// the retry helper can re-issue the request on 429 / 5xx / network error
// without the client having consumed the first (rate-limited or dropped)
// response. Concurrency is capped so the open-burst is paced under the
// cloud rate limit. Backoff is patient (up to ~8s) and honors Retry-After,
// because the cloud's 429 window can outlast a short retry sequence —
// giving up too early surfaces the failure to the client, where even a
// retried query can degrade a UI section to empty or trigger a toast.
//
// This is the single network-resilience layer for the whole relay: both
// `forwardToCloud` (POST /api/cloud-proxy, used by callCloudProxy for
// event history) and `proxyToCloud` (reverse-proxy /api/v1/* in pure-cloud
// mode) route their upstream fetch through here.
async function fetchWithRetry(options, maxRetries = 5) {
  await acquire();
  try {
    let lastResult = null;
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const result = await fetchUpstream(options);
        lastResult = result;
        lastError = null;
        if (!isRetriableStatus(result.statusCode)) return result;
        if (attempt === maxRetries) {
          console.warn(
            `[cloud-proxy] ${result.statusCode} persisted after ${maxRetries} retries: ` +
              `${options.url.pathname}${options.url.search}`,
          );
          return result;
        }
      } catch (err) {
        lastResult = null;
        lastError = err;
        // A non-transient programming/system error (e.g. a bad URL) must not
        // be retried — surface it immediately. Only retry transient network
        // codes (ECONNRESET, ETIMEDOUT, ...) and the socket-timer timeout.
        if (!isTransientFetchError(err)) throw err;
        if (attempt === maxRetries) {
          console.warn(
            `[cloud-proxy] network error persisted after ${maxRetries} retries: ` +
              `${options.url.pathname}${options.url.search} (${err.code || err.message})`,
          );
          throw err;
        }
      }
      const headers = lastResult?.headers;
      await sleep(backoffDelay(attempt, headers));
    }
    // Unreachable: the loop either returns a result or rethrows on the final
    // attempt. Guard for safety.
    if (lastResult) return lastResult;
    throw lastError ?? new Error("fetchWithRetry exhausted with no result");
  } finally {
    release();
  }
}

function applyCors(res) {
  res.setHeader("access-control-allow-origin", ALLOW_ORIGIN);
  res.setHeader(
    "access-control-allow-methods",
    "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  );
  res.setHeader(
    "access-control-allow-headers",
    "Content-Type, X-Session-API-Key, X-Org-Id, Authorization, X-Expose-Secrets",
  );
  res.setHeader("access-control-allow-credentials", "true");
  res.setHeader("access-control-max-age", "600");
}

/** Forward the cloud-proxy envelope to Cloud and stream the response back. */
async function forwardToCloud(envelope, res) {
  const target = envelope.host || CLOUD_HOST;
  const method = (envelope.method || "GET").toUpperCase();
  const url = new URL(envelope.path || "/", target);
  const reqHeaders = { ...(envelope.headers || {}) };
  // Force server-side credentials so the browser never holds the key.
  reqHeaders["authorization"] = `Bearer ${CLOUD_API_KEY}`;
  reqHeaders["x-org-id"] = envelope.headers?.["x-org-id"] || CLOUD_ORG_ID;
  reqHeaders["x-openhands-client"] = "agent_canvas";
  reqHeaders["host"] = url.host;
  if (
    ["POST", "PATCH", "PUT"].includes(method) &&
    envelope.body !== undefined &&
    envelope.body !== null
  ) {
    reqHeaders["content-type"] =
      reqHeaders["content-type"] || "application/json";
  }

  const bodyBytes =
    envelope.body !== undefined && envelope.body !== null
      ? Buffer.from(
          typeof envelope.body === "string"
            ? envelope.body
            : JSON.stringify(envelope.body),
        )
      : null;
  if (bodyBytes) reqHeaders["content-length"] = String(bodyBytes.length);

  const timeoutMs = envelope.timeout_seconds
    ? envelope.timeout_seconds * 1000
    : 30_000;

  try {
    const result = await fetchWithRetry({
      url,
      method,
      reqHeaders,
      bodyBytes,
      timeoutMs,
    });
    res.writeHead(result.statusCode, {
      ...result.headers,
      "access-control-allow-origin": ALLOW_ORIGIN,
    });
    res.end(result.body);
  } catch (err) {
    console.error("[cloud-proxy] upstream error:", err.message);
    if (!res.headersSent)
      sendJson(res, 502, { error: "upstream_error", detail: err.message });
    else res.destroy();
  }
}

/** Reverse-proxy a request to the OSS agent-server. */
function proxyToAgentServer(req, res) {
  const url = new URL(req.url, AGENT_SERVER_URL);
  const isTls = url.protocol === "https:";
  const lib = isTls ? httpsRequest : httpRequest;
  const upstream = lib(
    {
      hostname: url.hostname,
      port: url.port || (isTls ? 443 : 80),
      path: url.pathname + url.search,
      method: req.method,
      headers: { ...req.headers, host: url.host },
    },
    (up) => {
      const h = { ...up.headers, "access-control-allow-origin": ALLOW_ORIGIN };
      res.writeHead(up.statusCode || 502, h);
      up.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    console.error("[agent-proxy] upstream error:", err.message);
    if (!res.headersSent)
      sendJson(res, 502, {
        error: "agent_server_unreachable",
        detail: err.message,
      });
    else res.destroy();
  });
  req.pipe(upstream);
}

/**
 * Reverse-proxy an agent-server-style request to the Cloud host.
 * Used in pure-cloud mode (AGENT_SERVER_URL disabled) so the Canvas can
 * reach the cloud's runtime endpoints (/api/v1/*, /sockets/*) through the
 * relay — injecting the Bearer token server-side, same as /api/cloud-proxy.
 */
function proxyToCloud(req, res) {
  const url = new URL(req.url, CLOUD_HOST);
  const reqHeaders = {
    ...req.headers,
    authorization: `Bearer ${CLOUD_API_KEY}`,
    "x-org-id": CLOUD_ORG_ID,
    "x-openhands-client": "agent_canvas",
    host: url.host,
  };
  // Buffer the request body so we can re-issue on a 429; pure-GET (history)
  // requests are the ones that get rate-limited on conversation open.
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const bodyBytes = Buffer.concat(chunks);
    if (bodyBytes.length)
      reqHeaders["content-length"] = String(bodyBytes.length);
    try {
      const result = await fetchWithRetry({
        url,
        method: req.method,
        reqHeaders,
        bodyBytes: bodyBytes.length ? bodyBytes : null,
        timeoutMs: 30_000,
      });
      res.writeHead(result.statusCode, {
        ...result.headers,
        "access-control-allow-origin": ALLOW_ORIGIN,
      });
      res.end(result.body);
      console.log(
        `[proxyToCloud] ${req.method} ${url.pathname}${url.search} -> ${result.statusCode} ct=${result.headers["content-type"] || "?"}`,
      );
    } catch (err) {
      console.error("[cloud-agent-proxy] upstream error:", err.message);
      if (!res.headersSent)
        sendJson(res, 502, { error: "cloud_unreachable", detail: err.message });
      else res.destroy();
    }
  });
  req.on("error", (err) => {
    console.error("[cloud-agent-proxy] request read error:", err.message);
    if (!res.headersSent)
      sendJson(res, 502, { error: "cloud_unreachable", detail: err.message });
  });
}

/** Upgrade a WebSocket connection — proxy to the cloud host in pure-cloud mode. */
function proxyWebSocketToCloud(req, socket, head) {
  const url = new URL(req.url, CLOUD_HOST);
  const isTls = url.protocol === "https:";
  const lib = isTls ? httpsRequest : httpRequest;
  console.log(`[cloud-ws] connecting to ${url.href} (tls=${isTls})`);
  const reqHeaders = {
    ...req.headers,
    authorization: `Bearer ${CLOUD_API_KEY}`,
    "x-org-id": CLOUD_ORG_ID,
    "x-openhands-client": "agent_canvas",
    host: url.host,
  };
  const upstream = lib({
    hostname: url.hostname,
    port: url.port || (isTls ? 443 : 80),
    path: url.pathname + url.search,
    method: req.method,
    headers: reqHeaders,
  });
  upstream.on("upgrade", (up, upSocket, upHead) => {
    console.log(
      `[cloud-ws] upgrade received from cloud, piping bidirectionally`,
    );
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
        [...Object.entries(up.headers)]
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n",
    );
    if (upHead.length) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    upSocket.on("error", (e) =>
      console.error("[cloud-ws] upSocket error:", e.message),
    );
    socket.on("error", (e) =>
      console.error("[cloud-ws] clientSocket error:", e.message),
    );
    socket.on("close", () => {
      console.log("[cloud-ws] client socket closed");
      upSocket.destroy();
    });
    upSocket.on("close", () => {
      console.log("[cloud-ws] upstream socket closed");
      if (!socket.destroyed) socket.destroy();
    });
  });
  upstream.on("response", (up) => {
    // Cloud responded with a normal HTTP response (not an upgrade) — usually an error.
    let body = "";
    up.on("data", (c) => (body += c));
    up.on("end", () => {
      console.error(
        `[cloud-ws] cloud returned HTTP ${up.statusCode} (not upgrade): ${body.slice(0, 200)}`,
      );
      if (!socket.destroyed) {
        socket.write(`HTTP/1.1 ${up.statusCode} ${up.statusMessage || ""}\r\n`);
        [...Object.entries(up.headers)].forEach(([k, v]) =>
          socket.write(`${k}: ${v}\r\n`),
        );
        socket.write("\r\n");
        socket.write(body);
        socket.end();
      }
    });
  });
  upstream.on("error", (err) => {
    console.error("[cloud-ws-proxy] upstream error:", err.message);
    if (!socket.destroyed) socket.destroy();
  });
  if (head.length) upstream.write(head);
  upstream.end();
}

/** Serve a static file with SPA fallback. */
async function serveStatic(req, res) {
  if (!STATIC_DIR) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (rel.includes("..")) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  let filePath = normalize(join(STATIC_DIR, rel));
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) filePath = join(filePath, "index.html");
  } catch {
    filePath = join(STATIC_DIR, "index.html"); // SPA fallback
  }
  try {
    const data = await readFile(filePath);
    const ext = filePath.split(".").pop();
    const types = {
      html: "text/html",
      js: "text/javascript",
      css: "text/css",
      json: "application/json",
      svg: "image/svg+xml",
      png: "image/png",
      ico: "image/x-icon",
      woff2: "font/woff2",
    };
    res.writeHead(200, {
      "content-type": types[ext] || "application/octet-stream",
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "not_found", path: req.url });
  }
}

const server = createServer((req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Log all non-asset requests for debugging.
  const pathOnly0 = req.url.split("?")[0];
  if (!pathOnly0.startsWith("/assets/") && pathOnly0 !== "/") {
    console.log(`[req] ${req.method} ${req.url}`);
  }

  // Relay-level liveness probe. Independent of both the cloud and the (optional)
  // agent server, so it works in pure-cloud mode where /alive and /health are
  // agent-server prefixes that return 503. Use this as the deployment health
  // check (e.g. render.yaml `healthCheckPath`).
  //
  // When STATIC_DIR is configured, the probe only reports ok once the SPA
  // entry point (index.html) is actually readable. This keeps Render from
  // marking the service "live" before the static build is on disk, which would
  // otherwise serve {"error":"not_found"} JSON for every page while /healthz
  // stayed green (buildCommand and startCommand run sequentially, but a build
  // step that fails to emit build/index.html — or a cold start racing the
  // filesystem — would otherwise slip through).
  if (req.method === "GET" && req.url.split("?")[0] === "/healthz") {
    let staticReady = !STATIC_DIR; // no static dir = nothing to verify
    const finish = () =>
      sendJson(res, staticReady ? 200 : 503, {
        ok: staticReady,
        service: "cloud-proxy-relay",
        agent_server: AGENT_SERVER_URL ? "enabled" : "disabled",
        static_dir: Boolean(STATIC_DIR),
      });
    if (!STATIC_DIR) {
      finish();
      return;
    }
    stat(join(STATIC_DIR, "index.html"))
      .then((s) => {
        staticReady = s.isFile();
      })
      .catch(() => {
        staticReady = false;
      })
      .then(finish);
    return;
  }

  // The cloud-proxy relay endpoint.
  if (req.method === "POST" && req.url.split("?")[0] === CLOUD_PROXY_PATH) {
    if (PROXY_KEY) {
      const key = req.headers["x-session-api-key"];
      if (key !== PROXY_KEY) {
        sendJson(res, 401, { error: "invalid_proxy_key" });
        return;
      }
    }
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      let envelope;
      try {
        envelope = JSON.parse(buf || "{}");
      } catch {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }
      forwardToCloud(envelope, res);
    });
    return;
  }

  // Everything else: agent-server reverse-proxy or static files.
  const pathOnly = req.url.split("?")[0];
  const isAgentPrefix = AGENT_PREFIXES.some(
    (p) =>
      pathOnly === p ||
      pathOnly.startsWith(p + "/") ||
      pathOnly.startsWith(p + "?"),
  );
  if (AGENT_SERVER_URL && isAgentPrefix) {
    proxyToAgentServer(req, res);
    return;
  }
  if (isAgentPrefix) {
    // Pure-cloud mode: no OSS agent server is configured, but the cloud host
    // serves these same runtime endpoints. Proxy to the cloud host with the
    // Bearer token injected server-side — same model as /api/cloud-proxy but
    // for the Canvas's direct agent-server calls (/api/v1/*, /sockets/*).
    proxyToCloud(req, res);
    return;
  }
  if (STATIC_DIR) {
    serveStatic(req, res);
    return;
  }
  sendJson(res, 404, { error: "not_found", path: req.url });
});

// WebSocket upgrade handler — in pure-cloud mode, proxy /sockets/* to the
// cloud host with the Bearer token injected. When an OSS agent server is
// configured, proxy there instead.
server.on("upgrade", (req, socket, head) => {
  console.log(`[ws-upgrade] ${req.method} ${req.url}`);
  const pathOnly = req.url.split("?")[0];
  const isSocketPrefix =
    pathOnly === "/sockets" || pathOnly.startsWith("/sockets/");
  if (!isSocketPrefix) {
    console.log(`[ws-upgrade] rejecting non-socket path: ${pathOnly}`);
    socket.destroy();
    return;
  }
  if (AGENT_SERVER_URL) {
    // Proxy to the OSS agent server (no auth injection needed — the Canvas
    // sends X-Session-API-Key itself for local setups).
    const url = new URL(req.url, AGENT_SERVER_URL);
    const isTls = url.protocol === "https:";
    const lib = isTls ? httpsRequest : httpRequest;
    const upstream = lib({
      hostname: url.hostname,
      port: url.port || (isTls ? 443 : 80),
      path: url.pathname + url.search,
      method: req.method,
      headers: { ...req.headers, host: url.host },
    });
    upstream.on("upgrade", (up, upSocket, upHead) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n` +
          [...Object.entries(up.headers)]
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n") +
          "\r\n\r\n",
      );
      if (upHead.length) socket.write(upHead);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
    });
    upstream.on("error", () => {
      if (!socket.destroyed) socket.destroy();
    });
    if (head.length) upstream.write(head);
    upstream.end();
  } else {
    // Pure-cloud mode: proxy the WebSocket to the cloud host with auth.
    proxyWebSocketToCloud(req, socket, head);
  }
});

// Resolve the org ID (from env or auto-derived from the API key) before
// listening so every proxied request has a valid X-Org-Id from the start.
resolveOrgId().then(() => {
  server.listen(PORT, () => {
    console.log(`[cloud-proxy-relay] listening on http://0.0.0.0:${PORT}`);
    console.log(`  cloud host : ${CLOUD_HOST}`);
    console.log(`  org id     : ${CLOUD_ORG_ID}`);
    console.log(`  /api/cloud-proxy -> Cloud (Bearer injected server-side)`);
    if (AGENT_SERVER_URL)
      console.log(
        `  agent-server proxy: ${AGENT_PREFIXES.join(", ")} -> ${AGENT_SERVER_URL}`,
      );
    else
      console.log(
        `  agent-server proxy: ${AGENT_PREFIXES.join(", ")} -> ${CLOUD_HOST} (pure-cloud mode, Bearer injected)`,
      );
    if (STATIC_DIR) console.log(`  static dir : ${STATIC_DIR}`);
  });
});
