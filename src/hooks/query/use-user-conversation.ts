import { useRef } from "react";
import { Query, useQuery } from "@tanstack/react-query";
import AgentServerConversationService from "#/api/conversation-service/agent-server-conversation-service.api";
import { AppConversation } from "#/api/conversation-service/agent-server-conversation-service.types";
import { useActiveBackend } from "#/contexts/active-backend-context";
import { retryOnTransient } from "#/utils/react-query-retry";

const FIVE_MINUTES = 1000 * 60 * 5;
const FIFTEEN_MINUTES = 1000 * 60 * 15;

type RefetchInterval = (
  query: Query<
    AppConversation | null,
    unknown,
    AppConversation | null,
    (string | null)[]
  >,
) => number | undefined | false | null;

export const useUserConversation = (
  cid: string | null,
  refetchInterval?: RefetchInterval,
) => {
  const active = useActiveBackend();

  // The cid belongs to whichever backend was active when the user opened this
  // conversation. If they switch to a *different* backend (e.g. cloud → local)
  // without leaving the conversation view, the cid is foreign to the new
  // backend; fetching it makes that backend parse a response for an id it
  // doesn't own and surfaces a confusing "agent server returned data this UI
  // does not understand" toast. Pin the cid to its origin backend and disable
  // the query until the route navigates to a valid id. Compare backend id
  // ONLY — org changes within the same backend (e.g. the cloud
  // personal-workspace self-heal in BackendSelector) keep the same
  // agent-server schema and must still refetch.
  const origin = useRef({ cid, backendId: active.backend.id });
  if (origin.current.cid !== cid) {
    origin.current = { cid, backendId: active.backend.id };
  }
  const backendChanged = origin.current.backendId !== active.backend.id;

  return useQuery({
    // Include the active backend identity so each (backend, org) pair
    // maintains its own per-conversation cache entry. Without this, a
    // local→cloud→local switch can leave a `null` cached value (from a
    // refetch that ran while the cloud backend was active) under the
    // shared cid key, which then makes the conversation route toast
    // "conversation not available or no permission" until the user
    // hard-refreshes the page. Mirrors `usePaginatedConversations`.
    queryKey: ["user", "conversation", cid, active.backend.id, active.orgId],
    queryFn: async () => {
      if (!cid) return null;

      // Use the V1 batch API endpoint to get a single conversation
      const results =
        await AgentServerConversationService.batchGetAppConversations([cid]);
      return results[0] ?? null;
    },
    enabled: !!cid && !cid.startsWith("task-") && !backendChanged,
    // Opening a conversation is gated on this metadata fetch resolving: the
    // history query (`useConversationHistory`) stays disabled until the
    // conversation record (with `conversation_url`) is available, so a
    // transient failure here with `retry: false` stranded the whole
    // conversation as a blank suggestions page with no error and no retry.
    // Retry confirmed transient failures (429/5xx + network drops, which
    // includes cloud-path fetch timeouts) a handful of times; non-transient
    // errors (a 404 for a genuinely missing conversation) still fail fast so
    // the route can navigate away.
    retry: retryOnTransient,
    // Merge the caller's provisioning-state poll (e.g. the 3 s fast-poll
    // while a sandbox is still provisioning) with a self-heal: if every
    // retry above still fails, keep re-running on a slow interval until the
    // conversation record arrives, so a conversation opened during a relay
    // outage or cloud rate-limit burst fills itself in without the user
    // having to refresh. Stops once it succeeds (no error).
    refetchInterval: (query) => {
      if (query.state.error && query.state.fetchStatus !== "fetching") {
        return 10_000;
      }
      return refetchInterval?.(query) ?? undefined;
    },
    refetchIntervalInBackground: true,
    staleTime: FIVE_MINUTES,
    gcTime: FIFTEEN_MINUTES,
    // Suppress the global "Disconnected (check URL or network)" toast. This
    // query runs on every conversation open and fast-polls every 3s while the
    // sandbox is provisioning/paused; a momentary network blip on the relay
    // would otherwise re-toast repeatedly. The route surfaces a genuine
    // "conversation not available" error itself (it checks `isFetched` and
    // navigates), so the generic connection toast here is pure noise.
    meta: { disableToast: true },
  });
};
