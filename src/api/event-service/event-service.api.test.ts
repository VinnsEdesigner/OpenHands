import { beforeEach, describe, expect, it, vi } from "vitest";

const { callCloudProxyMock } = vi.hoisted(() => ({
  callCloudProxyMock: vi.fn(),
}));

vi.mock("@openhands/typescript-client/clients", () => ({
  ConversationClient: class {},
}));
vi.mock("@openhands/typescript-client/events/remote-events-list", () => ({
  RemoteEventsList: class {},
}));
vi.mock("../backend-registry/active-store", () => ({
  getActiveBackend: () => ({ backend: { kind: "cloud" } }),
}));
vi.mock("../cloud/proxy", () => ({ callCloudProxy: callCloudProxyMock }));
vi.mock("../agent-server-client-options", () => ({
  getAgentServerClientOptions: vi.fn(),
  getAgentServerHttpClientOptions: vi.fn(),
}));

import EventService from "./event-service.api";

// Mirrors the SDK's HttpError shape enough for `isSdkHttpError` (which
// checks name === "HttpError" + a numeric `status`) to recognize it.
const httpError = (status: number, message = `HTTP ${status}`) => {
  const err = new Error(message);
  err.name = "HttpError";
  Object.assign(err, { status });
  return err;
};

describe("EventService.searchEvents strict pagination", () => {
  beforeEach(() => {
    callCloudProxyMock.mockReset();
  });

  it("rethrows unsupported cloud pagination for completeness-sensitive callers", async () => {
    const paginationError = new Error("pagination unsupported");
    callCloudProxyMock.mockRejectedValue(paginationError);

    await expect(
      EventService.searchEvents("conversation-1", null, null, {
        limit: 100,
        sortOrder: "TIMESTAMP_DESC",
        strictPagination: true,
      }),
    ).rejects.toBe(paginationError);
  });

  it("retains the empty-page fallback for ordinary chat pagination", async () => {
    callCloudProxyMock.mockRejectedValue(new Error("pagination unsupported"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      EventService.searchEvents("conversation-1", null, null, {
        limit: 50,
        timestampLt: "2026-07-10T12:34:56.000Z",
      }),
    ).resolves.toEqual({ items: [], next_page_id: null });

    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("EventService.searchEvents transient cloud failures", () => {
  beforeEach(() => {
    callCloudProxyMock.mockReset();
  });

  it("propagates a 429 on the initial history load instead of caching an empty page", async () => {
    // The Canvas opens a finished conversation; the cloud rate-limits the
    // initial events/search burst. Degrading to empty here would render the
    // conversation blank and cache that empty page, so the 429 must throw
    // for the query layer to retry.
    callCloudProxyMock.mockRejectedValue(httpError(429));

    await expect(
      EventService.searchEvents("conversation-1", null, null, {
        limit: 50,
        sortOrder: "TIMESTAMP_DESC",
      }),
    ).rejects.toThrow(/429/);
  });

  it("propagates a 429 on a timestamp-filtered (load-older) request rather than degrading to empty", async () => {
    callCloudProxyMock.mockRejectedValue(httpError(429));

    await expect(
      EventService.searchEvents("conversation-1", null, null, {
        limit: 50,
        sortOrder: "TIMESTAMP_DESC",
        timestampLt: "2026-07-10T12:34:56.000Z",
      }),
    ).rejects.toThrow(/429/);
  });

  it("propagates a 5xx on a timestamp-filtered request rather than degrading to empty", async () => {
    // A 503 is transient (overload/maintenance), not the #14399 500-on-
    // timestamp-filters bug, so it should still surface for retry.
    callCloudProxyMock.mockRejectedValue(httpError(503));

    await expect(
      EventService.searchEvents("conversation-1", null, null, {
        limit: 50,
        sortOrder: "TIMESTAMP_DESC",
        timestampLt: "2026-07-10T12:34:56.000Z",
      }),
    ).rejects.toThrow(/503/);
  });
});
