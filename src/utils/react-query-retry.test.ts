import { describe, expect, it } from "vitest";
import { AxiosError } from "axios";
import {
  getHttpErrorStatus,
  isTransientHttpError,
  retryOnTransient,
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

  it("retries non-HTTP/network errors a few times but not forever", () => {
    const err = new Error("network drop");
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
