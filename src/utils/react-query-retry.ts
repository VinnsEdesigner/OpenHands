import { AxiosError } from "axios";
import { isSdkHttpError } from "#/api/agent-server-compatibility";

/**
 * Extract an HTTP status code from either an SDK `HttpError` (cloud-proxy
 * path) or an axios `AxiosError` (local-runtime path). Returns `null` for
 * non-HTTP errors (network failures, thrown `Error`s with no status), which
 * the caller treats as non-transient so we don't retry programming bugs or
 * genuine connectivity loss forever.
 */
export function getHttpErrorStatus(error: unknown): number | null {
  if (isSdkHttpError(error)) {
    return (error as { status: number }).status;
  }
  if (error instanceof AxiosError) {
    return error.response?.status ?? error.status ?? null;
  }
  return null;
}

/**
 * Whether an error is an HTTP error at all — i.e. it carries a status code
 * from either the SDK `HttpError` or an axios `AxiosError`. Plain `Error`s
 * (e.g. a validation error thrown in a queryFn, or a non-HTTP exception)
 * return false. Used to distinguish "a real upstream HTTP response we can
 * reason about" from "a thrown error with no status".
 */
export function isHttpError(error: unknown): boolean {
  return getHttpErrorStatus(error) !== null;
}

/**
 * Whether a non-HTTP error looks like a genuine network/connectivity
 * failure that is safe to retry. The cloud path (`@openhands/typescript-client`
 * `CloudClient`) uses `fetch` + `AbortSignal.timeout`, NOT axios, so a dropped
 * connection or a request timeout surfaces as a plain `Error`/`TypeError`
 * with no HTTP status and no `response`:
 *
 *   - `Error("Request timeout after 30000ms")` — the SDK wraps
 *     `AbortSignal.timeout`'s `TimeoutError` into this message.
 *   - `TypeError("Failed to fetch")` — a network-level failure (DNS, TCP,
 *     TLS, CORS preflight rejection, the relay being unreachable).
 *   - `DOMException` named `AbortError`/`TimeoutError` — some runtimes
 *     surface the raw abort instead of the wrapped message.
 *
 * These are the cloud-mode equivalents of the local axios "no response"
 * network drop: the request never produced a definitive HTTP result, so
 * retrying is strictly safe (idempotent GETs) and is the second line of
 * defense behind the relay's own proxy-layer retries. A plain `Error`
 * thrown from a queryFn (e.g. a malformed-response validation error) has a
 * different, deterministic message and is NOT matched here, so it still
 * fails fast rather than retrying for seconds.
 */
export function isNetworkDropError(error: unknown): boolean {
  if (error instanceof AxiosError) return !error.response;
  if (!(error instanceof Error)) return false;
  // The SDK's timeout wrapper (see CloudClient.fetchAndParse).
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  const msg = error.message || "";
  if (msg.startsWith("Request timeout after")) return true;
  // fetch() network/CORS/TCP failures. Match the canonical message plus the
  // common variants runtimes emit; a validation `Error` never matches these.
  return (
    msg.includes("Failed to fetch") ||
    msg.includes("NetworkError") ||
    msg.includes("network request failed") ||
    // Node fetch undici errors leak through in SSR/preview builds.
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("fetch failed")
  );
}

/**
 * Whether an error is a transient HTTP failure worth retrying: 429
 * (rate-limit) and 5xx (overload/maintenance). The cloud host rate-limits
 * the Canvas's conversation-open burst with 429s; retrying with backoff
 * (rather than failing fast) lets the request land once the limit window
 * clears, instead of silently degrading the UI section to empty/error.
 */
export function isTransientHttpError(error: unknown): boolean {
  const status = getHttpErrorStatus(error);
  return status === 429 || (status !== null && status >= 500);
}

/**
 * React Query `retry` function that retries only confirmed transient HTTP
 * failures (429 / 5xx), up to `maxRetries` attempts. Non-transient errors
 * (404, 400, 401, plain `Error`s with no HTTP status) fail immediately so
 * the UI can react — e.g. a missing endpoint hides its section instead of
 * hammering the server, and a validation error surfaces right away.
 *
 * Network errors (no HTTP status — a dropped connection, a relay 502 that
 * gave up after its own retries, or a cloud-path fetch timeout) are retried a
 * few times too, since they're often a momentary blip. The relay
 * (`scripts/relay/cloud-proxy-relay.mjs`) is the primary network-resilience
 * layer (it retries network drops, 429, and 5xx at the proxy); this
 * query-level retry is a second line of defense for the cases where the relay
 * itself is unreachable, its retries are exhausted, or the upstream hung past
 * the fetch timeout.
 *
 * Use in place of `retry: false` (which swallows transient 429s as permanent
 * failures) or the default `retry: 3` (which also retries non-transient
 * errors pointlessly) for queries whose backend can rate-limit or overload.
 */
export function retryOnTransient(
  failureCount: number,
  error: unknown,
  maxRetries = 5,
): boolean {
  const status = getHttpErrorStatus(error);
  if (status === null) {
    // No HTTP status → not an HTTP response. Retry a handful of times only
    // if it looks like a genuine network/connectivity failure: either a
    // local axios error with no response, OR a cloud-path fetch error
    // (timeout / "Failed to fetch" / AbortError) that never produced an
    // HTTP result. A plain thrown `Error` (e.g. a validation error) is
    // neither and is not retried — it fails immediately so the UI can
    // surface the real problem rather than silently retrying for seconds.
    return isNetworkDropError(error) ? failureCount < 3 : false;
  }
  if (isTransientHttpError(error)) return failureCount < maxRetries;
  return false;
}

/**
 * Like `retryOnTransient` but tuned for the one fetch the UI absolutely
 * cannot silently fail: the initial conversation history load. Opening a
 * conversation that renders blank (no events, no error) is the worst
 * experience this app can produce, so the initial-history fetch retries
 * harder than a typical background query:
 *
 *   - confirmed transient HTTP failures (429 rate-limit / 5xx) retry up to
 *     `maxRetries` (default 8) — the cloud host frequently 429s the burst
 *     of requests fired when a conversation opens, and a few extra attempts
 *     with react-query's exponential backoff let the request land once the
 *     limit window clears instead of showing an empty chat.
 *   - genuine network drops (no HTTP status: a local axios no-response, a
 *     cloud-path fetch timeout/abort, or a "Failed to fetch") also retry up
 *     to `networkRetries` (default 6) — these are the cases where the relay
 *     itself is momentarily unreachable or the upstream hung past the fetch
 *     timeout, and giving up after 3 (the default `retryOnTransient` value)
 *     leaves a finished conversation blank.
 *
 * Non-transient HTTP errors (404/400/401) and plain validation `Error`s
 * still fail fast: retrying a 404 forever would just delay a real "not
 * found", and retrying a programming bug is pointless.
 *
 * Use ONLY for the initial history query; per-page "load older" pagination
 * stays best-effort via `retryOnTransient`.
 */
export function retryOnTransientAggressive(
  failureCount: number,
  error: unknown,
  maxRetries = 8,
  networkRetries = 6,
): boolean {
  const status = getHttpErrorStatus(error);
  if (status === null) {
    // Cloud-path fetch timeouts/aborts and local axios no-response drops are
    // the cases where the relay itself was momentarily unreachable (or the
    // upstream hung past the fetch timeout). Giving up after 3 (the default
    // `retryOnTransient` value) leaves a finished conversation blank, so the
    // initial-history fetch retries harder here. A plain validation `Error`
    // is not a network drop and still fails fast.
    return isNetworkDropError(error) ? failureCount < networkRetries : false;
  }
  if (isTransientHttpError(error)) return failureCount < maxRetries;
  return false;
}
