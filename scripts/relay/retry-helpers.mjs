// Pure, side-effect-free retry decision helpers for the cloud-proxy relay.
// Extracted from `cloud-proxy-relay.mjs` (which starts an HTTP server on
// import) so they can be unit-tested in isolation.
//
// These functions encode the relay's network-resilience policy:
//   - which upstream HTTP statuses are worth retrying (429 / 5xx),
//   - which thrown network errors are transient (ECONNRESET, ETIMEDOUT, ...),
//   - how long to back off between retries.

// Node network error codes that represent a transient connection failure
// (the upstream dropped the connection, the TCP probe timed out, a TLS
// renegotiation hiccuped, etc.) rather than a definitive "this can never
// work" result. Retrying these is strictly safe — the request is
// idempotent from the cloud's perspective (GET history / 429-retry) and the
// relay's concurrency semaphore keeps us from hammering the upstream.
const TRANSIENT_NET_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRINUSE",
  "EHOSTDOWN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

export const isTransientNetworkError = (err) =>
  !!err &&
  typeof err === "object" &&
  "code" in err &&
  TRANSIENT_NET_CODES.has(err.code);

// Whether an upstream response status is worth retrying: 429 (rate-limit)
// and 5xx (overload / maintenance / transient gateway error). 4xx other
// than 429 is a definitive client error (404 missing, 400 bad path) and
// must be returned immediately so the frontend can react.
export const isRetriableStatus = (statusCode) =>
  statusCode === 429 || (statusCode >= 500 && statusCode < 600);

// Exponential backoff delay (ms) for attempt `attempt` (0-indexed). Honors
// the upstream `Retry-After` header (capped) for 429s; otherwise uses an
// exponential schedule capped at 8s — long enough to clear the observed
// per-key rate-limit window and most cloud-side blips without making the
// conversation-open burst feel frozen.
export function backoffDelay(attempt, headers) {
  const retryAfter = headers?.["retry-after"];
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    // Honor the server's hint, capped so a misbehaving upstream can't
    // stall a request slot indefinitely.
    return Math.min(parseInt(retryAfter, 10) * 1000, 10_000);
  }
  // 0.5s, 1s, 2s, 4s, 8s, 8s, 8s...
  return Math.min(500 * 2 ** attempt, 8_000);
}

// Decide whether a thrown error from `fetchUpstream` is transient enough to
// warrant a retry. Covers known Node network codes plus the `upstream timeout`
// error raised by the relay's socket timer (which has no `.code`).
export function isTransientFetchError(err) {
  if (isTransientNetworkError(err)) return true;
  const msg = err?.message || "";
  return typeof msg === "string" && msg.startsWith("upstream timeout");
}
