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
 * gave up after its own retries) are retried a few times too, since they're
 * often a momentary blip. The relay (`scripts/relay/cloud-proxy-relay.mjs`)
 * is the primary network-resilience layer (it retries network drops, 429, and
 * 5xx at the proxy); this query-level retry is a second line of defense for
 * the cases where the relay itself is unreachable or its retries are
 * exhausted.
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
    // if it looks like a genuine network/connectivity failure (an
    // AxiosError with no response, i.e. the request never reached the
    // server). A plain thrown `Error` (e.g. a validation error) is NOT an
    // AxiosError and is not retried — it fails immediately so the UI can
    // surface the real problem rather than silently retrying for seconds.
    const isNetworkDrop = error instanceof AxiosError && !error.response;
    return isNetworkDrop ? failureCount < 3 : false;
  }
  if (isTransientHttpError(error)) return failureCount < maxRetries;
  return false;
}
