import { describe, it, expect } from "vitest";

// Import the pure retry decision logic from the relay helper module. These
// are extracted from cloud-proxy-relay.mjs (which starts an HTTP server on
// load) so they can be unit-tested in isolation.
import {
  isRetriableStatus,
  isTransientNetworkError,
  isTransientFetchError,
  backoffDelay,
} from "../../scripts/relay/retry-helpers.mjs";

describe("relay retry-helpers", () => {
  describe("isRetriableStatus", () => {
    it("retries 429 (rate-limit)", () => {
      expect(isRetriableStatus(429)).toBe(true);
    });

    it("retries all 5xx (overload / maintenance / gateway)", () => {
      expect(isRetriableStatus(500)).toBe(true);
      expect(isRetriableStatus(502)).toBe(true);
      expect(isRetriableStatus(503)).toBe(true);
      expect(isRetriableStatus(504)).toBe(true);
      expect(isRetriableStatus(599)).toBe(true);
    });

    it("does not retry 2xx success", () => {
      expect(isRetriableStatus(200)).toBe(false);
      expect(isRetriableStatus(204)).toBe(false);
    });

    it("does not retry 4xx client errors other than 429 (404/400 must surface)", () => {
      expect(isRetriableStatus(400)).toBe(false);
      expect(isRetriableStatus(401)).toBe(false);
      expect(isRetriableStatus(403)).toBe(false);
      expect(isRetriableStatus(404)).toBe(false);
    });

    it("does not retry 600+ (non-standard)", () => {
      expect(isRetriableStatus(600)).toBe(false);
      expect(isRetriableStatus(700)).toBe(false);
    });
  });

  describe("isTransientNetworkError", () => {
    it("recognizes transient Node network codes", () => {
      expect(isTransientNetworkError({ code: "ECONNRESET" })).toBe(true);
      expect(isTransientNetworkError({ code: "ETIMEDOUT" })).toBe(true);
      expect(isTransientNetworkError({ code: "EPIPE" })).toBe(true);
      expect(isTransientNetworkError({ code: "EAI_AGAIN" })).toBe(true);
      expect(isTransientNetworkError({ code: "UND_ERR_SOCKET" })).toBe(true);
    });

    it("does not treat non-network errors as transient", () => {
      expect(isTransientNetworkError({ code: "ERR_INVALID_ARG_TYPE" })).toBe(
        false,
      );
      expect(isTransientNetworkError(new Error("bad url"))).toBe(false);
      expect(isTransientNetworkError(null)).toBe(false);
      expect(isTransientNetworkError(undefined)).toBe(false);
    });
  });

  describe("isTransientFetchError", () => {
    it("treats transient network codes as retryable", () => {
      expect(isTransientFetchError({ code: "ECONNRESET" })).toBe(true);
    });

    it("treats the relay's socket-timer timeout as retryable (no .code)", () => {
      expect(
        isTransientFetchError(new Error("upstream timeout after 30000ms")),
      ).toBe(true);
    });

    it("does not retry a non-network programming error", () => {
      expect(isTransientFetchError(new Error("Invalid URL"))).toBe(false);
    });
  });

  describe("backoffDelay", () => {
    it("uses exponential backoff capped at 8s when no Retry-After header", () => {
      // 0.5s, 1s, 2s, 4s, 8s, 8s, 8s...
      expect(backoffDelay(0, {})).toBe(500);
      expect(backoffDelay(1, {})).toBe(1000);
      expect(backoffDelay(2, {})).toBe(2000);
      expect(backoffDelay(3, {})).toBe(4000);
      expect(backoffDelay(4, {})).toBe(8000);
      expect(backoffDelay(5, {})).toBe(8000);
      expect(backoffDelay(10, {})).toBe(8000);
    });

    it("honors Retry-After (seconds) when present, capped at 10s", () => {
      expect(backoffDelay(0, { "retry-after": "2" })).toBe(2000);
      expect(backoffDelay(0, { "retry-after": "5" })).toBe(5000);
      // Capped so a misbehaving upstream can't stall a slot indefinitely.
      expect(backoffDelay(0, { "retry-after": "60" })).toBe(10_000);
    });

    it("ignores a non-numeric Retry-After and falls back to exponential", () => {
      expect(backoffDelay(0, { "retry-after": "now" })).toBe(500);
      expect(backoffDelay(2, { "retry-after": "" })).toBe(2000);
    });
  });
});
