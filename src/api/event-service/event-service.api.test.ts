import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  buildHttpBaseUrlMock,
  callCloudProxyMock,
  conversationClientConstructorMock,
  getActiveBackendMock,
  getAgentServerClientOptionsMock,
  getAgentServerHttpClientOptionsMock,
  getEventCountMock,
  remoteEventsListConstructorMock,
  remoteSearchMock,
  respondToConfirmationMock,
} = vi.hoisted(() => ({
  buildHttpBaseUrlMock: vi.fn(),
  callCloudProxyMock: vi.fn(),
  conversationClientConstructorMock: vi.fn(),
  getActiveBackendMock: vi.fn(),
  getAgentServerClientOptionsMock: vi.fn(),
  getAgentServerHttpClientOptionsMock: vi.fn(),
  getEventCountMock: vi.fn(),
  remoteEventsListConstructorMock: vi.fn(),
  remoteSearchMock: vi.fn(),
  respondToConfirmationMock: vi.fn(),
}));

vi.mock("@openhands/typescript-client/clients", () => ({
  ConversationClient: class {
    constructor(options: unknown) {
      conversationClientConstructorMock(options);
    }

    respondToConfirmation = respondToConfirmationMock;
    getEventCount = getEventCountMock;
  },
}));
vi.mock("@openhands/typescript-client/events/remote-events-list", () => ({
  RemoteEventsList: class {
    constructor(options: unknown, conversationId: string) {
      remoteEventsListConstructorMock(options, conversationId);
    }

    search = remoteSearchMock;
  },
}));
vi.mock("#/utils/websocket-url", () => ({
  buildHttpBaseUrl: buildHttpBaseUrlMock,
}));
vi.mock("../backend-registry/active-store", () => ({
  getActiveBackend: getActiveBackendMock,
}));
vi.mock("../cloud/proxy", () => ({ callCloudProxy: callCloudProxyMock }));
vi.mock("../agent-server-client-options", () => ({
  getAgentServerClientOptions: getAgentServerClientOptionsMock,
  getAgentServerHttpClientOptions: getAgentServerHttpClientOptionsMock,
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

const cloudBackend = {
  id: "cloud-backend",
  name: "Cloud",
  host: "https://app.example.com",
  apiKey: "cloud-api-key",
  kind: "cloud",
};

const localBackend = {
  id: "local-backend",
  name: "Local",
  host: "http://localhost:3000",
  apiKey: "local-api-key",
  kind: "local",
};

function useBackend(backend: typeof cloudBackend | typeof localBackend): void {
  getActiveBackendMock.mockReturnValue({ backend, orgId: null });
}

describe("EventService", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useBackend(cloudBackend);
    buildHttpBaseUrlMock.mockReturnValue("https://runtime.example.com/base");
    getAgentServerClientOptionsMock.mockReturnValue({
      host: "http://local-client.example.com",
      apiKey: "client-key",
      workingDir: "workspace/project",
    });
    getAgentServerHttpClientOptionsMock.mockReturnValue({
      baseUrl: "http://local-http.example.com",
      apiKey: "http-key",
      timeout: 60_000,
    });
  });

  describe("respondToConfirmation", () => {
    it("routes cloud confirmations straight to the runtime via the typed client", async () => {
      const request = { accept: false, reason: "Needs human review" };
      respondToConfirmationMock.mockResolvedValue({ success: true });

      await expect(
        EventService.respondToConfirmation(
          "conversation-cloud",
          "wss://runtime.example.com/base/api/conversations/conversation-cloud",
          request,
          "session-key",
        ),
      ).resolves.toEqual({ success: true });

      // Cloud now calls the runtime host directly (CORS allowlisted),
      // authenticated with the session key — no /api/cloud-proxy envelope.
      expect(callCloudProxyMock).not.toHaveBeenCalled();
      expect(getAgentServerClientOptionsMock).toHaveBeenCalledWith({
        conversationUrl:
          "wss://runtime.example.com/base/api/conversations/conversation-cloud",
        sessionApiKey: "session-key",
      });
      expect(conversationClientConstructorMock).toHaveBeenCalledWith({
        host: "http://local-client.example.com",
        apiKey: "client-key",
        workingDir: "workspace/project",
      });
      expect(respondToConfirmationMock).toHaveBeenCalledWith(
        "conversation-cloud",
        request,
      );
    });

    it("uses the typed conversation client for local confirmations", async () => {
      useBackend(localBackend);
      respondToConfirmationMock.mockResolvedValue({ success: false });

      await expect(
        EventService.respondToConfirmation(
          "conversation-local",
          "http://localhost:3000/api/conversations/conversation-local",
          { accept: true },
        ),
      ).resolves.toEqual({ success: false });

      expect(getAgentServerClientOptionsMock).toHaveBeenCalledWith({
        conversationUrl:
          "http://localhost:3000/api/conversations/conversation-local",
        sessionApiKey: undefined,
      });
      expect(conversationClientConstructorMock).toHaveBeenCalledWith({
        host: "http://local-client.example.com",
        apiKey: "client-key",
        workingDir: "workspace/project",
      });
      expect(respondToConfirmationMock).toHaveBeenCalledWith(
        "conversation-local",
        { accept: true },
      );
      expect(callCloudProxyMock).not.toHaveBeenCalled();
    });
  });

  describe("getEventCount", () => {
    it("gets the cloud count straight from the runtime via the typed client", async () => {
      getEventCountMock.mockResolvedValue(17);

      await expect(
        EventService.getEventCount(
          "conversation-cloud",
          "https://runtime.example.com/api/conversations/conversation-cloud",
          null,
        ),
      ).resolves.toBe(17);

      // Cloud now calls the runtime host directly (CORS allowlisted) —
      // no /api/cloud-proxy envelope.
      expect(callCloudProxyMock).not.toHaveBeenCalled();
      expect(getAgentServerClientOptionsMock).toHaveBeenCalledWith({
        conversationUrl:
          "https://runtime.example.com/api/conversations/conversation-cloud",
        sessionApiKey: null,
      });
      expect(conversationClientConstructorMock).toHaveBeenCalledWith({
        host: "http://local-client.example.com",
        apiKey: "client-key",
        workingDir: "workspace/project",
      });
      expect(getEventCountMock).toHaveBeenCalledWith("conversation-cloud");
    });

    it("gets the local count from the typed conversation client", async () => {
      useBackend(localBackend);
      getEventCountMock.mockResolvedValue(8);

      await expect(
        EventService.getEventCount(
          "conversation-local",
          "http://localhost:3000/api/conversations/conversation-local",
          "session-key",
        ),
      ).resolves.toBe(8);

      expect(getAgentServerClientOptionsMock).toHaveBeenCalledWith({
        conversationUrl:
          "http://localhost:3000/api/conversations/conversation-local",
        sessionApiKey: "session-key",
      });
      expect(conversationClientConstructorMock).toHaveBeenCalledWith({
        host: "http://local-client.example.com",
        apiKey: "client-key",
        workingDir: "workspace/project",
      });
      expect(getEventCountMock).toHaveBeenCalledWith("conversation-local");
      expect(callCloudProxyMock).not.toHaveBeenCalled();
    });
  });

  describe("searchEvents", () => {
    it("caps cloud limits and forwards every supported history filter", async () => {
      const event = { id: "event-1" };
      callCloudProxyMock.mockResolvedValue({
        items: [event],
        next_page_id: "page-2",
      });

      await expect(
        EventService.searchEvents("conversation-cloud", null, null, {
          limit: 250,
          pageId: "page-1",
          sortOrder: "TIMESTAMP_DESC",
          timestampGte: "2026-07-12T00:00:00.000Z",
          timestampLt: "2026-07-13T00:00:00.000Z",
        }),
      ).resolves.toEqual({ items: [event], next_page_id: "page-2" });

      expect(callCloudProxyMock).toHaveBeenCalledWith({
        backend: cloudBackend,
        method: "GET",
        path: "/api/v1/conversation/conversation-cloud/events/search?limit=100&sort_order=TIMESTAMP_DESC&page_id=page-1&timestamp__gte=2026-07-12T00%3A00%3A00.000Z&timestamp__lt=2026-07-13T00%3A00%3A00.000Z",
      });
    });

    it("uses default cloud options and normalizes a missing response", async () => {
      callCloudProxyMock.mockResolvedValue(undefined);

      await expect(
        EventService.searchEvents("conversation-cloud"),
      ).resolves.toEqual({ items: [], next_page_id: null });

      expect(callCloudProxyMock).toHaveBeenCalledWith({
        backend: cloudBackend,
        method: "GET",
        path: "/api/v1/conversation/conversation-cloud/events/search?limit=100",
      });
    });

    it("preserves zero as an explicit cloud limit", async () => {
      callCloudProxyMock.mockResolvedValue({});

      await expect(
        EventService.searchEvents("conversation-cloud", null, null, {
          limit: 0,
        }),
      ).resolves.toEqual({ items: [], next_page_id: null });

      expect(callCloudProxyMock).toHaveBeenCalledWith({
        backend: cloudBackend,
        method: "GET",
        path: "/api/v1/conversation/conversation-cloud/events/search?limit=0",
      });
    });

    it("rethrows cloud failures when no pagination filter was requested", async () => {
      const searchError = new Error("cloud unavailable");
      callCloudProxyMock.mockRejectedValue(searchError);

      await expect(
        EventService.searchEvents("conversation-cloud", null, null, {
          limit: 25,
        }),
      ).rejects.toBe(searchError);
    });

    it("rethrows filtered cloud failures for completeness-sensitive callers", async () => {
      const paginationError = new Error("pagination unsupported");
      callCloudProxyMock.mockRejectedValue(paginationError);

      await expect(
        EventService.searchEvents("conversation-cloud", null, null, {
          pageId: "page-2",
          strictPagination: true,
        }),
      ).rejects.toBe(paginationError);
    });

    it("degrades to an empty page when both the full-param and limit+sort retries fail", async () => {
      callCloudProxyMock.mockRejectedValue(new Error("pagination unsupported"));
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);

      await expect(
        EventService.searchEvents("conversation-cloud", null, null, {
          timestampLt: "2026-07-10T12:34:56.000Z",
        }),
      ).resolves.toEqual({ items: [], next_page_id: null });

      // The full-param request and the limit+sort retry both ran.
      expect(callCloudProxyMock).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0][0])).toContain(
        "rejected both full-param",
      );
      warn.mockRestore();
    });

    it("propagates a sort-only cloud failure instead of degrading the initial load", async () => {
      const paginationError = new Error("pagination unsupported");
      callCloudProxyMock.mockRejectedValue(paginationError);

      await expect(
        EventService.searchEvents("conversation-cloud", null, null, {
          sortOrder: "TIMESTAMP_DESC",
        }),
      ).rejects.toBe(paginationError);

      // A sort-only request is the initial conversation-open load; it must not
      // be cached as a blank page, so it propagates on the first failure.
      expect(callCloudProxyMock).toHaveBeenCalledTimes(1);
    });

    it("recognizes a lower timestamp bound as a cloud pagination filter", async () => {
      callCloudProxyMock.mockResolvedValue({
        items: [],
        next_page_id: null,
      });

      await EventService.searchEvents("conversation-cloud", null, null, {
        timestampGte: "2026-07-10T12:34:56.000Z",
      });

      expect(callCloudProxyMock).toHaveBeenCalledWith({
        backend: cloudBackend,
        method: "GET",
        path: "/api/v1/conversation/conversation-cloud/events/search?limit=100&timestamp__gte=2026-07-10T12%3A34%3A56.000Z",
      });
    });

    it("passes all local filters to the remote events list", async () => {
      useBackend(localBackend);
      const event = { id: "event-local" };
      remoteSearchMock.mockResolvedValue({
        items: [event],
        next_page_id: "local-page-2",
      });

      await expect(
        EventService.searchEvents(
          "conversation-local",
          "http://localhost:3000/api/conversations/conversation-local",
          "session-key",
          {
            limit: 40,
            pageId: "local-page-1",
            sortOrder: "TIMESTAMP",
            timestampGte: "2026-07-11T00:00:00.000Z",
            timestampLt: "2026-07-12T00:00:00.000Z",
          },
        ),
      ).resolves.toEqual({
        items: [event],
        next_page_id: "local-page-2",
      });

      expect(getAgentServerHttpClientOptionsMock).toHaveBeenCalledWith({
        conversationUrl:
          "http://localhost:3000/api/conversations/conversation-local",
        sessionApiKey: "session-key",
      });
      expect(remoteEventsListConstructorMock).toHaveBeenCalledWith(
        {
          baseUrl: "http://local-http.example.com",
          apiKey: "http-key",
          timeout: 60_000,
        },
        "conversation-local",
      );
      expect(remoteSearchMock).toHaveBeenCalledWith({
        limit: 40,
        page_id: "local-page-1",
        sort_order: "TIMESTAMP",
        timestamp__gte: "2026-07-11T00:00:00.000Z",
        timestamp__lt: "2026-07-12T00:00:00.000Z",
      });
      expect(callCloudProxyMock).not.toHaveBeenCalled();
    });

    it("uses default local options and normalizes a missing page", async () => {
      useBackend(localBackend);
      remoteSearchMock.mockResolvedValue(undefined);

      await expect(
        EventService.searchEvents("conversation-local"),
      ).resolves.toEqual({ items: [], next_page_id: null });

      expect(getAgentServerHttpClientOptionsMock).toHaveBeenCalledWith({
        conversationUrl: undefined,
        sessionApiKey: undefined,
      });
      expect(remoteSearchMock).toHaveBeenCalledWith({ limit: 100 });
    });
  });
});

describe("EventService.searchEvents transient cloud failures", () => {
  beforeEach(() => {
    callCloudProxyMock.mockReset();
    useBackend(cloudBackend);
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
    // A 503 is transient (overload/maintenance), not the (now-fixed) #14399
    // 500-on-timestamp-filters bug, so it should still surface for retry.
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

// `buildHttpBaseUrl` (stubbed at the top of this file) derives the runtime host
// override; the suite below resets it so each test controls the returned host
// without depending on window.location.
describe("EventService.searchEvents runtime-first history routing", () => {
  beforeEach(() => {
    callCloudProxyMock.mockReset();
    useBackend(cloudBackend);
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
