import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetActiveStoreForTests,
  setActiveSelection,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import EventService from "#/api/event-service/event-service.api";
import { callCloudProxy } from "#/api/cloud/proxy";
import type { Backend } from "#/api/backend-registry/types";

vi.mock("#/api/cloud/proxy", () => ({
  callCloudProxy: vi.fn(),
}));

const cloudBackend: Backend = {
  id: "cloud-1",
  name: "Production",
  host: "https://app.all-hands.dev",
  apiKey: "cloud-key",
  kind: "cloud",
};

beforeEach(() => {
  window.localStorage.clear();
  __resetActiveStoreForTests();
  setRegisteredBackends([cloudBackend]);
  setActiveSelection({ backendId: cloudBackend.id, orgId: "org-1" });
  vi.mocked(callCloudProxy).mockReset();
  vi.mocked(callCloudProxy).mockResolvedValue({
    items: [],
    next_page_id: null,
  });
});

afterEach(() => {
  window.localStorage.clear();
  __resetActiveStoreForTests();
  vi.mocked(callCloudProxy).mockReset();
});

describe("EventService.searchEvents — cloud branch", () => {
  it("forwards all pagination params to the cloud proxy and clamps limit to <=100", async () => {
    const options = {
      limit: 500,
      sortOrder: "TIMESTAMP_DESC" as const,
      pageId: "p1",
      timestampGte: "2026-05-01T00:00:00.000000",
      timestampLt: "2026-05-12T07:20:29.087853",
    };

    await EventService.searchEvents("conv-1", null, null, options);

    const proxyCall = vi.mocked(callCloudProxy).mock.calls[0][0];
    const url = new URL(`https://x${proxyCall.path}`);
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("sort_order")).toBe("TIMESTAMP_DESC");
    expect(url.searchParams.get("page_id")).toBe("p1");
    expect(url.searchParams.get("timestamp__gte")).toBe(
      "2026-05-01T00:00:00.000000",
    );
    expect(url.searchParams.get("timestamp__lt")).toBe(
      "2026-05-12T07:20:29.087853",
    );
  });

  it("sends only limit when no filter params are provided", async () => {
    await EventService.searchEvents("conv-1", null, null, { limit: 50 });

    const proxyCall = vi.mocked(callCloudProxy).mock.calls[0][0];
    expect(proxyCall.path).toBe(
      "/api/v1/conversation/conv-1/events/search?limit=50",
    );
  });

  it("retries without timestamp filters when a full-param request fails (#14399), then returns the retry's items", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // First (full-param) call 500s because of the timestamp filter; the retry
    // (timestamp filters dropped, sort_order kept) succeeds and returns items.
    vi.mocked(callCloudProxy)
      .mockRejectedValueOnce(new Error("Internal Server Error"))
      .mockResolvedValueOnce({
        items: [{ id: "evt-1" }, { id: "evt-2" }],
        next_page_id: null,
      });

    const result = await EventService.searchEvents("conv-1", null, null, {
      limit: 50,
      sortOrder: "TIMESTAMP_DESC",
      timestampLt: "2026-05-12T00:00:00.000000",
    });

    // Two calls: full-param, then retry without timestamp filters.
    expect(vi.mocked(callCloudProxy)).toHaveBeenCalledTimes(2);

    const firstCall = vi.mocked(callCloudProxy).mock.calls[0][0];
    const firstUrl = new URL(`https://x${firstCall.path}`);
    expect(firstUrl.searchParams.get("sort_order")).toBe("TIMESTAMP_DESC");
    expect(firstUrl.searchParams.get("timestamp__lt")).toBe(
      "2026-05-12T00:00:00.000000",
    );

    const retryCall = vi.mocked(callCloudProxy).mock.calls[1][0];
    const retryUrl = new URL(`https://x${retryCall.path}`);
    // sort_order preserved (keeps DESC ordering); timestamp filter dropped.
    expect(retryUrl.searchParams.get("sort_order")).toBe("TIMESTAMP_DESC");
    expect(retryUrl.searchParams.has("timestamp__lt")).toBe(false);
    expect(retryUrl.searchParams.has("timestamp__gte")).toBe(false);

    expect(result.items).toHaveLength(2);
    expect(result.next_page_id).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled(); // no warn — retry succeeded

    warnSpy.mockRestore();
  });

  it("forces next_page_id=null on a successful timestamp-filter retry (stops the pagination loop)", async () => {
    // The #14399 retry drops `timestamp__lt`, so it can only return the newest
    // page — the same ids the store already holds. Returning that page WITH a
    // live `next_page_id` would make the "load older" UI re-fetch the same
    // newest page forever (dupes, nothing added, hasMore stays true). The fix
    // forces `next_page_id: null` so pagination stops after the degradation.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.mocked(callCloudProxy)
      .mockRejectedValueOnce(new Error("Internal Server Error"))
      .mockResolvedValueOnce({
        items: [{ id: "evt-1" }, { id: "evt-2" }],
        next_page_id: "would-loop-forever",
      });

    const result = await EventService.searchEvents("conv-1", null, null, {
      limit: 50,
      sortOrder: "TIMESTAMP_DESC",
      timestampLt: "2026-05-12T00:00:00.000000",
    });

    expect(vi.mocked(callCloudProxy)).toHaveBeenCalledTimes(2);
    // Items are returned (the retry succeeded), but pagination is terminated.
    expect(result.items).toHaveLength(2);
    expect(result.next_page_id).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("load-older path degrades to empty page on a non-transient failure (keeps loaded history)", async () => {
    // A `timestamp__lt` anchor means this is scroll-up "load older", not the
    // initial conversation-open load. A non-transient failure on both the
    // full-param request and the timestamp-filter-dropped retry must STOP
    // pagination gracefully (return empty) so the already-loaded recent
    // history stays visible — surfacing an error during a background scroll
    // the user didn't initiate would be wrong. (Transient 429/5xx still
    // throw for retry — covered in the co-located test.)
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    vi.mocked(callCloudProxy)
      .mockRejectedValueOnce(new Error("Internal Server Error"))
      .mockRejectedValueOnce(new Error("Internal Server Error"));

    const result = await EventService.searchEvents("conv-1", null, null, {
      limit: 50,
      sortOrder: "TIMESTAMP_DESC",
      timestampLt: "2026-05-12T00:00:00.000000",
    });

    expect(vi.mocked(callCloudProxy)).toHaveBeenCalledTimes(2);
    expect(result.items).toHaveLength(0);
    expect(result.next_page_id).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("rejected both full-param"),
    );

    warnSpy.mockRestore();
  });

  it("throws when an initial-load request (sort_order only, no timestamp) fails", async () => {
    // No `timestamp__lt` → this is the initial conversation-open load, which
    // the UI cannot silently fail. A non-transient failure must PROPAGATE so
    // the query layer enters its error state and the UI can render a retry
    // affordance instead of a cached blank conversation.
    vi.mocked(callCloudProxy).mockRejectedValueOnce(
      new Error("Internal Server Error"),
    );

    await expect(
      EventService.searchEvents("conv-1", null, null, {
        limit: 50,
        sortOrder: "TIMESTAMP_DESC",
      }),
    ).rejects.toThrow("Internal Server Error");

    // No timestamp filters to drop → no retry → single call, then throw.
    expect(vi.mocked(callCloudProxy)).toHaveBeenCalledTimes(1);
  });

  it("rethrows when a limit-only request (no filter params) fails", async () => {
    vi.mocked(callCloudProxy).mockRejectedValueOnce(new Error("Network error"));

    await expect(
      EventService.searchEvents("conv-1", null, null, { limit: 50 }),
    ).rejects.toThrow("Network error");

    expect(vi.mocked(callCloudProxy)).toHaveBeenCalledTimes(1);
  });

  it("stops pagination when server returns fewer items than limit", async () => {
    vi.mocked(callCloudProxy).mockResolvedValueOnce({
      items: [{ id: "evt-1" }, { id: "evt-2" }],
      next_page_id: null,
    });

    const result = await EventService.searchEvents("conv-1", null, null, {
      limit: 50,
      sortOrder: "TIMESTAMP_DESC",
    });

    expect(result.items).toHaveLength(2);
    expect(result.next_page_id).toBeNull();
  });
});
