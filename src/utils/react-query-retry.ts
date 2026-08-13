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
 * React Query `retry` function that retries only transient HTTP failures
 * (429 / 5xx), up to `maxRetries` attempts. Non-transient errors (404, 400,
 * 401, plain `Error`s) fail immediately so the UI can react — e.g. a missing
 * endpoint hides its section instead of hammering the server. Network errors
 * (no status) are retried too, since they're often a momentary blip.
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
  // Plain errors with no HTTP status (network drop, timeout): retry a few
  // times — a flaky connection shouldn't permanently break the section.
  const status = getHttpErrorStatus(error);
  if (status === null) return failureCount < 3;
  if (isTransientHttpError(error)) return failureCount < maxRetries;
  return false;
}
