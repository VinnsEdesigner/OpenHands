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

// `buildHttpBaseUrl` is used to derive the runtime host override; stub it so
// the test asserts the hostOverride passed to callCloudProxy without
// depending on window.location.
const { buildHttpBaseUrlMock } = vi.hoisted(() => ({
  buildHttpBaseUrlMock: vi.fn((url: string | null | undefined) =>
    url ? `https://runtime.test${url ? "" : ""}` : "",
  ),
}));
vi.mock("#/utils/websocket-url", () => ({
  buildHttpBaseUrl: buildHttpBaseUrlMock,
}));

describe("EventService.searchEvents runtime-first history routing", () => {
  beforeEach(() => {
    callCloudProxyMock.mockReset();
    buildHttpBaseUrlMock.mockReset();
    buildHttpBaseUrlMock.mockImplementation((url: string | null | undefined) =>
      url ? `https://runtime-from-url.test` : "",
    );
  });

  it("prefers the runtime sandbox endpoint when conversation_url is present and returns its result", async () => {
    // A live conversation: the runtime endpoint is ~500x faster and returns
    // clean events. The cloud App API must NOT be hit at all.
    const runtimePage = {
      items: [{ id: "rt-1", kind: "ActionEvent" }],
      next_page_id: "rt-cursor",
    };
    callCloudProxyMock.mockResolvedValueOnce(runtimePage);

    const result = await EventService.searchEvents(
      "conversation-1",
      "https://sandbox.example/api/conversations/conversation-1",
      "session-key-1",
      { limit: 50, sortOrder: "TIMESTAMP_DESC" },
    );

    expect(result).toEqual({
      items: [{ id: "rt-1", kind: "ActionEvent" }],
      next_page_id: "rt-cursor",
    });
    expect(callCloudProxyMock).toHaveBeenCalledTimes(1);
    const arg = callCloudProxyMock.mock.calls[0][0];
    expect(arg.hostOverride).toBe("https://runtime-from-url.test");
    expect(arg.authMode).toBe("session-api-key");
    expect(arg.sessionApiKey).toBe("session-key-1");
    expect(arg.path).toBe(
      "/api/conversations/conversation-1/events/search?limit=50&sort_order=TIMESTAMP_DESC",
    );
  });

  it("falls back to the cloud App API when the runtime sandbox fails (sandbox sleeping/paused)", async () => {
    // The runtime endpoint rejects (e.g. 404 because the sandbox slept); the
    // App API persists events server-side and must serve the fallback. The
    // runtime failure is absorbed (warn), not rethrown.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    callCloudProxyMock
      .mockRejectedValueOnce(httpError(404)) // runtime attempt fails
      .mockResolvedValueOnce({
        items: [{ id: "cloud-1", kind: "StreamingDeltaEvent" }],
        next_page_id: "cloud-cursor",
      }); // App API fallback succeeds

    const result = await EventService.searchEvents(
      "conversation-1",
      "https://sandbox.example/api/conversations/conversation-1",
      "session-key-1",
      { limit: 50, sortOrder: "TIMESTAMP_DESC" },
    );

    expect(result).toEqual({
      items: [{ id: "cloud-1", kind: "StreamingDeltaEvent" }],
      next_page_id: "cloud-cursor",
    });
    expect(callCloudProxyMock).toHaveBeenCalledTimes(2);
    // First call: runtime (hostOverride + session-api-key).
    const runtimeArg = callCloudProxyMock.mock.calls[0][0];
    expect(runtimeArg.hostOverride).toBeTruthy();
    expect(runtimeArg.authMode).toBe("session-api-key");
    // Second call: App API (no hostOverride, default bearer).
    const appArg = callCloudProxyMock.mock.calls[1][0];
    expect(appArg.hostOverride).toBeUndefined();
    expect(appArg.path).toBe(
      "/api/v1/conversation/conversation-1/events/search?limit=50&sort_order=TIMESTAMP_DESC",
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("goes straight to the cloud App API when no conversation_url is available", async () => {
    // A finished conversation whose sandbox record has no live url: there is
    // no runtime host to try, so the App API is the only path (no runtime
    // attempt).
    callCloudProxyMock.mockResolvedValueOnce({
      items: [],
      next_page_id: null,
    });

    await EventService.searchEvents("conversation-1", null, null, {
      limit: 50,
      sortOrder: "TIMESTAMP_DESC",
    });

    expect(callCloudProxyMock).toHaveBeenCalledTimes(1);
    const arg = callCloudProxyMock.mock.calls[0][0];
    expect(arg.hostOverride).toBeUndefined();
    expect(arg.path).toBe(
      "/api/v1/conversation/conversation-1/events/search?limit=50&sort_order=TIMESTAMP_DESC",
    );
  });
});
