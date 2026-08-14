import { ConversationClient } from "@openhands/typescript-client/clients";
import { RemoteEventsList } from "@openhands/typescript-client/events/remote-events-list";
import { OpenHandsEvent } from "#/types/agent-server/core";
import { buildHttpBaseUrl } from "#/utils/websocket-url";
import { getActiveBackend } from "../backend-registry/active-store";
import { callCloudProxy } from "../cloud/proxy";
import {
  getAgentServerClientOptions,
  getAgentServerHttpClientOptions,
} from "../agent-server-client-options";
import { isSdkHttpError } from "../agent-server-compatibility";
import type {
  ConfirmationResponseRequest,
  ConfirmationResponseResponse,
  EventSearchOptions,
  EventSearchPage,
} from "./event-service.types";

/**
 * Cloud-mode REST calls are split between two upstream hosts (matching
 * OpenHands' cloud frontend):
 *
 *   - **App API** (`backend.host`, default in `callCloudProxy`):
 *     event *history* (`/api/v1/conversation/{id}/events/search`).
 *     Persisted by the cloud backend — survives the runtime sandbox.
 *
 *   - **Runtime sandbox** (extracted from `conversation.conversation_url`
 *     and passed as `hostOverride`): live runtime endpoints like
 *     `/api/conversations/{id}/events/count` and
 *     `/api/conversations/{id}/events/respond_to_confirmation`. Auth on
 *     these endpoints is `X-Session-API-Key`, not `Authorization: Bearer`.
 *
 * App API calls go directly to the cloud backend with bearer auth. Runtime
 * sandbox calls go through `/api/cloud-proxy`, which avoids depending on CORS
 * for per-conversation runtime hosts.
 *
 * Local mode keeps the existing typescript-client path: it targets the
 * conversation's host directly via typed client classes.
 */
class EventService {
  static async respondToConfirmation(
    conversationId: string,
    conversationUrl: string,
    request: ConfirmationResponseRequest,
    sessionApiKey?: string | null,
  ): Promise<ConfirmationResponseResponse> {
    const active = getActiveBackend().backend;

    if (active.kind === "cloud") {
      return callCloudProxy<ConfirmationResponseResponse>({
        backend: active,
        method: "POST",
        hostOverride: buildHttpBaseUrl(conversationUrl),
        path: `/api/conversations/${conversationId}/events/respond_to_confirmation`,
        body: request,
        authMode: "session-api-key",
        sessionApiKey,
      });
    }

    return new ConversationClient(
      getAgentServerClientOptions({
        conversationUrl,
        sessionApiKey,
      }),
    ).respondToConfirmation<ConfirmationResponseResponse>(
      conversationId,
      request,
    );
  }

  static async getEventCount(
    conversationId: string,
    conversationUrl: string,
    sessionApiKey?: string | null,
  ): Promise<number> {
    const active = getActiveBackend().backend;

    if (active.kind === "cloud") {
      return callCloudProxy<number>({
        backend: active,
        method: "GET",
        hostOverride: buildHttpBaseUrl(conversationUrl),
        path: `/api/conversations/${conversationId}/events/count`,
        authMode: "session-api-key",
        sessionApiKey,
      });
    }

    return new ConversationClient(
      getAgentServerClientOptions({
        conversationUrl,
        sessionApiKey,
      }),
    ).getEventCount(conversationId);
  }

  /**
   * Search events for a conversation. Returns the raw page so callers can
   * paginate (via `next_page_id`) and so REST-driven history loading can
   * tell when there are no more older events to load.
   */
  static async searchEvents(
    conversationId: string,
    conversationUrl?: string | null,
    sessionApiKey?: string | null,
    options: EventSearchOptions = {},
  ): Promise<EventSearchPage<OpenHandsEvent>> {
    const active = getActiveBackend().backend;
    const limit = options.limit ?? 100;

    if (active.kind === "cloud") {
      // Event *history* lives on the cloud App API, not the runtime
      // sandbox. Path is singular `conversation` and v1-prefixed.
      //
      // Full pagination params (sort_order, page_id, timestamp filters)
      // require the server-side fix from OpenHands/OpenHands#14399. If
      // the cloud backend hasn't been updated yet, the timestamp filters
      // trigger a 500 (str-vs-datetime comparison). We attempt the full
      // request first; on failure we retry with the timestamp filters
      // dropped (sort_order + page_id + limit only) so the caller still
      // gets the most-recent events and the UI can open at the last
      // message instead of falling back to a full WebSocket replay.
      const cloudLimit = Math.min(limit, 100);
      const hasFilterParams = !!(
        options.sortOrder ||
        options.pageId ||
        options.timestampGte ||
        options.timestampLt
      );
      const hasTimestampFilters = !!(
        options.timestampGte || options.timestampLt
      );

      const params = new URLSearchParams();
      params.set("limit", String(cloudLimit));
      if (options.sortOrder) params.set("sort_order", options.sortOrder);
      if (options.pageId) params.set("page_id", options.pageId);
      if (options.timestampGte)
        params.set("timestamp__gte", options.timestampGte);
      if (options.timestampLt) params.set("timestamp__lt", options.timestampLt);

      const doCloudSearch = (searchParams: URLSearchParams) =>
        callCloudProxy<EventSearchPage<OpenHandsEvent>>({
          backend: active,
          method: "GET",
          path: `/api/v1/conversation/${conversationId}/events/search?${searchParams.toString()}`,
        });

      try {
        const data = await doCloudSearch(params);
        return {
          items: data?.items ?? [],
          next_page_id: data?.next_page_id ?? null,
        };
      } catch (err) {
        // Transient failures (429 rate-limit, 5xx) must propagate so the
        // query layer retries them — silently degrading to an empty page
        // here would cache a blank history and render an already-finished
        // conversation as empty. The degrade-to-empty fallback below exists
        // only for the #14399 server bug (500 on timestamp filters), not for
        // retries that could still succeed.
        const status = isSdkHttpError(err)
          ? (err as { status: number }).status
          : null;
        const isTransient =
          status === 429 || (status !== null && status >= 500);
        if (!hasFilterParams || isTransient) throw err;
        if (options.strictPagination) throw err;

        // If the failure involved timestamp filters, retry without them —
        // #14399's 500 is a str-vs-datetime comparison that only affects
        // timestamp__gte/__lt, not sort_order or page_id. Keeping sort_order
        // preserves DESC ordering (so the caller's reverse-to-chronological
        // stays correct) while avoiding the broken filter.
        //
        // IMPORTANT: the retry drops `timestamp__lt`, so it can only return
        // the *most recent* page — the same ids the store already holds when
        // paginating older events. Returning that page WITH a live
        // `next_page_id` makes the caller think there's more to load, but the
        // next page is identical (dupes), so `addEvents` no-ops, `hasMore`
        // stays true, and the "load older" UI re-fires forever (a stuck
        // spinner). We therefore return the retried items but force
        // `next_page_id: null` so pagination STOPS after this degradation —
        // the caller treats it as "no more older events" rather than looping
        // on duplicate newest-page results.
        if (hasTimestampFilters) {
          const retriedParams = new URLSearchParams();
          retriedParams.set("limit", String(cloudLimit));
          if (options.sortOrder)
            retriedParams.set("sort_order", options.sortOrder);
          if (options.pageId) retriedParams.set("page_id", options.pageId);
          try {
            const data = await doCloudSearch(retriedParams);
            return {
              items: data?.items ?? [],
              // Force pagination to stop: the timestamp anchor is gone, so
              // any next_page_id would re-fetch the newest page again (dupes).
              next_page_id: null,
            };
          } catch (retryErr) {
            // This is the "load older events" path (a `timestamp__lt` anchor
            // is set), not the initial conversation-open load. Transient
            // failures (429/5xx) propagate so the query/scroll layer retries;
            // a non-transient failure degrades to an empty page so scroll-up
            // pagination simply stops, leaving the already-loaded recent
            // history intact (the caller treats "no new events" as
            // exhaustion). Throwing here would surface an error during a
            // background scroll the user didn't initiate.
            const retryStatus = isSdkHttpError(retryErr)
              ? (retryErr as { status: number }).status
              : null;
            if (
              retryStatus === 429 ||
              (retryStatus !== null && retryStatus >= 500)
            ) {
              throw retryErr;
            }
            console.warn(
              "[EventService] Cloud backend rejected both full-param and " +
                "limit+sort retry for older-events pagination. Stopping " +
                "pagination (keeping loaded history). " +
                "Server needs OpenHands/OpenHands#14399.",
            );
            return { items: [], next_page_id: null };
          }
        }

        // No timestamp filters — this is the INITIAL conversation-open load
        // (just `sort_order`, no `timestamp__lt`). This is the one fetch the UI
        // cannot silently fail: degrading to an empty page here would cache a
        // blank result, render an existing conversation as empty with no error
        // and no retry, and — because the WebSocket is deliberately never used
        // as a history fallback — leave the user with nothing. Propagate so
        // the query layer enters its error state, retries aggressively, and
        // the UI surfaces an explicit retry affordance instead of going blank.
        // (Transient 429/5xx were already rethrown above for retry.)
        throw err;
      }
    }

    const page = await new RemoteEventsList(
      getAgentServerHttpClientOptions({ conversationUrl, sessionApiKey }),
      conversationId,
    ).search({
      limit,
      ...(options.pageId ? { page_id: options.pageId } : {}),
      ...(options.sortOrder ? { sort_order: options.sortOrder } : {}),
      ...(options.timestampGte ? { timestamp__gte: options.timestampGte } : {}),
      ...(options.timestampLt ? { timestamp__lt: options.timestampLt } : {}),
    });

    return {
      items: (page?.items ?? []) as OpenHandsEvent[],
      next_page_id: page?.next_page_id ?? null,
    };
  }
}

export default EventService;
