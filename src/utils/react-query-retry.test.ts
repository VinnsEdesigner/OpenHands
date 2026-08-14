import { describe, expect, it } from "vitest";
import { AxiosError } from "axios";
import {
  getHttpErrorStatus,
  isNetworkDropError,
  isTransientHttpError,
  retryOnTransient,
  retryOnTransientAggressive,
} from "./react-query-retry";

// Mirrors the SDK's HttpError shape (name + numeric status) that
// `isSdkHttpError` checks for — without importing the real class.
const sdkHttpError = (status: number): Error => {
  const err = new Error(`HTTP ${status}`);
  err.name = "HttpError";
  Object.assign(err, { status });
  return err;
};

const axiosError = (status: number): AxiosError =>
  new AxiosError("err", "ERR", undefined, undefined, {
    status,
    statusText: "",
    headers: {},
    config: {} as never,
    data: null,
  } as never);

describe("getHttpErrorStatus", () => {
  it("reads the status off an SDK HttpError", () => {
    expect(getHttpErrorStatus(sdkHttpError(429))).toBe(429);
  });

  it("reads the status off an axios error", () => {
    expect(getHttpErrorStatus(axiosError(503))).toBe(503);
  });

  it("returns null for a plain error with no status", () => {
    expect(getHttpErrorStatus(new Error("boom"))).toBeNull();
    expect(getHttpErrorStatus(undefined)).toBeNull();
  });
});

describe("isTransientHttpError", () => {
  it("treats 429 and 5xx as transient", () => {
    expect(isTransientHttpError(sdkHttpError(429))).toBe(true);
    expect(isTransientHttpError(axiosError(500))).toBe(true);
    expect(isTransientHttpError(axiosError(503))).toBe(true);
  });

  it("treats 4xx (other than 429) as non-transient", () => {
    expect(isTransientHttpError(sdkHttpError(404))).toBe(false);
    expect(isTransientHttpError(axiosError(400))).toBe(false);
    expect(isTransientHttpError(axiosError(401))).toBe(false);
  });

  it("treats non-HTTP errors as non-transient", () => {
    expect(isTransientHttpError(new Error("network drop"))).toBe(false);
  });
});

describe("retryOnTransient", () => {
  it("retries 429 up to the max (default 5)", () => {
    const err = sdkHttpError(429);
    expect(retryOnTransient(0, err)).toBe(true);
    expect(retryOnTransient(4, err)).toBe(true);
    expect(retryOnTransient(5, err)).toBe(false);
  });

  it("retries 5xx up to the max", () => {
    const err = axiosError(503);
    expect(retryOnTransient(0, err)).toBe(true);
    expect(retryOnTransient(5, err)).toBe(false);
  });

  it("does not retry non-transient HTTP errors at all", () => {
    expect(retryOnTransient(0, sdkHttpError(404))).toBe(false);
    expect(retryOnTransient(0, axiosError(400))).toBe(false);
  });

  it("does not retry non-HTTP errors that are plain thrown Errors (validation fails fast)", () => {
    // A queryFn that throws a plain `Error` (e.g. a malformed-response
    // validation error) must surface immediately — retrying it for seconds
    // would just delay a deterministic failure. The relay
    // (scripts/relay/cloud-proxy-relay.mjs) owns cloud-path network
    // resilience (it retries ECONNRESET/ETIMEDOUT/5xx/429 at the proxy), so
    // a plain no-status Error reaching the query is not a network blip to
    // paper over.
    const err = new Error("Invalid conversation history response");
    expect(retryOnTransient(0, err)).toBe(false);
    expect(retryOnTransient(1, err)).toBe(false);
  });

  it("retries a genuine network drop (axios error with NO response) a few times but not forever", () => {
    // Local-runtime calls use axios; a dropped connection surfaces as an
    // AxiosError with no `response` (the request never reached the server).
    // There's no relay to absorb it in local mode, so the query retries a
    // handful of times as the second line of defense.
    const err = new AxiosError("network drop", "ERR_NETWORK");
    expect(retryOnTransient(0, err)).toBe(true);
    expect(retryOnTransient(2, err)).toBe(true);
    expect(retryOnTransient(3, err)).toBe(false);
  });

  it("respects a custom maxRetries", () => {
    const err = sdkHttpError(429);
    expect(retryOnTransient(0, err, 2)).toBe(true);
    expect(retryOnTransient(2, err, 2)).toBe(false);
  });
});

describe("isNetworkDropError", () => {
  it("recognizes a local axios drop (no response)", () => {
    const err = new AxiosError("network drop", "ERR_NETWORK");
    expect(isNetworkDropError(err)).toBe(true);
  });

  it("recognizes the cloud SDK's timeout wrapper", () => {
    // CloudClient.fetchAndParse wraps AbortSignal.timeout failures as a
    // plain Error with this message. Without recognizing it, the cloud
    // path never retried timeouts (the dominant failure for large
    // conversations) and the query errored on the first timeout.
    const err = new Error("Request timeout after 30000ms");
    expect(isNetworkDropError(err)).toBe(true);
  });

  it("recognizes raw fetch abort/timeout DOMExceptions", () => {
    // Some runtimes surface AbortSignal.timeout's abort as a bare Error
    // whose name is TimeoutError/AbortError rather than the SDK's wrapped
    // "Request timeout after Xms" message.
    const timeout = Object.assign(new Error("Aborted"), {
      name: "TimeoutError",
    });
    const abort = Object.assign(new Error("Aborted"), {
      name: "AbortError",
    });
    expect(isNetworkDropError(timeout)).toBe(true);
    expect(isNetworkDropError(abort)).toBe(true);
  });

  it("recognizes a fetch TypeError (Failed to fetch / network)", () => {
    expect(isNetworkDropError(new TypeError("Failed to fetch"))).toBe(true);
    expect(
      isNetworkDropError(
        new Error("NetworkError when attempting to fetch resource."),
      ),
    ).toBe(true);
    expect(isNetworkDropError(new Error("network request failed"))).toBe(true);
  });

  it("does NOT treat a plain validation Error as a network drop", () => {
    expect(
      isNetworkDropError(new Error("Invalid conversation history response")),
    ).toBe(false);
    expect(isNetworkDropError(new Error("boom"))).toBe(false);
    expect(isNetworkDropError(undefined)).toBe(false);
  });

  it("does NOT treat a non-network HTTP error as a drop", () => {
    expect(isNetworkDropError(sdkHttpError(404))).toBe(false);
    expect(isNetworkDropError(sdkHttpError(500))).toBe(false);
  });
});

describe("retryOnTransientAggressive (cloud-path network drops)", () => {
  it("retries a cloud fetch timeout up to networkRetries (default 6)", () => {
    const err = new Error("Request timeout after 30000ms");
    expect(retryOnTransientAggressive(0, err)).toBe(true);
    expect(retryOnTransientAggressive(5, err)).toBe(true);
    expect(retryOnTransientAggressive(6, err)).toBe(false);
  });

  it("retries a fetch TypeError up to networkRetries", () => {
    const err = new TypeError("Failed to fetch");
    expect(retryOnTransientAggressive(0, err)).toBe(true);
    expect(retryOnTransientAggressive(6, err)).toBe(false);
  });

  it("still fails fast on a plain validation Error", () => {
    const err = new Error(
      "Invalid conversation history response: expected page.items to be an array.",
    );
    expect(retryOnTransientAggressive(0, err)).toBe(false);
  });

  it("still fails fast on non-transient HTTP errors (404)", () => {
    expect(retryOnTransientAggressive(0, sdkHttpError(404))).toBe(false);
  });
});
