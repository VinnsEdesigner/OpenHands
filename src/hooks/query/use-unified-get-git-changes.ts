import React from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import AgentServerGitService from "#/api/git-service/agent-server-git-service.api";
import { useConversationId } from "#/hooks/use-conversation-id";
import { useActiveConversation } from "#/hooks/query/use-active-conversation";
import { useRuntimeIsReady } from "#/hooks/use-runtime-is-ready";
import { getGitPath } from "#/utils/get-git-path";
import { retryOnTransient } from "#/utils/react-query-retry";
import type { GitChange } from "#/api/open-hands.types";

/**
 * Prefetch the git-changes query for the active conversation into the React
 * Query cache, using the exact query key `useUnifiedGetGitChanges` reads, so
 * the Files tab renders instantly when the right panel opens (cache hit, no
 * refetch). Safe to call speculatively (e.g. the moment a swipe is
 * recognized): if the data is already fresh it's a no-op, and an in-flight
 * request is de-duped by React Query. Returns immediately if the runtime
 * isn't ready or there's no conversation.
 */
export function prefetchGitChanges(
  queryClient: QueryClient,
  conversationId: string | null | undefined,
  conversation:
    | {
        conversation_url?: string | null;
        session_api_key?: string | null;
        selected_repository?: string | null;
        workspace?: { working_dir?: string | null } | null;
      }
    | null
    | undefined,
): void {
  if (!conversationId) return;
  const gitPath = getGitPath(
    conversation?.selected_repository,
    conversation?.workspace?.working_dir?.trim(),
  );
  queryClient.prefetchQuery({
    queryKey: [
      "file_changes",
      conversationId,
      conversation?.conversation_url,
      conversation?.session_api_key,
      gitPath,
    ],
    queryFn: async () => {
      if (!conversationId) throw new Error("No conversation ID");
      return AgentServerGitService.getGitChanges(
        conversationId,
        conversation?.conversation_url,
        conversation?.session_api_key,
        gitPath,
      );
    },
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 15,
    meta: { disableToast: true },
  });
}

export const useUnifiedGetGitChanges = () => {
  const { conversationId } = useConversationId();
  const { data: conversation } = useActiveConversation();
  const [orderedChanges, setOrderedChanges] = React.useState<GitChange[]>([]);
  const previousDataRef = React.useRef<GitChange[] | null>(null);
  const runtimeIsReady = useRuntimeIsReady();

  const conversationUrl = conversation?.conversation_url;
  const sessionApiKey = conversation?.session_api_key;
  const selectedRepository = conversation?.selected_repository;
  const workingDir = conversation?.workspace?.working_dir?.trim();

  const gitPath = React.useMemo(
    () => getGitPath(selectedRepository, workingDir),
    [selectedRepository, workingDir],
  );

  const result = useQuery({
    queryKey: [
      "file_changes",
      conversationId,
      conversationUrl,
      sessionApiKey,
      gitPath,
    ],
    queryFn: async () => {
      if (!conversationId) throw new Error("No conversation ID");

      return AgentServerGitService.getGitChanges(
        conversationId,
        conversationUrl,
        sessionApiKey,
        gitPath,
      );
    },
    retry: retryOnTransient,
    staleTime: 1000 * 60 * 5, // 5 minutes
    gcTime: 1000 * 60 * 15, // 15 minutes
    refetchOnWindowFocus: false,
    enabled: runtimeIsReady && !!conversationId,
    meta: {
      disableToast: true,
    },
  });

  // Latest changes should be on top
  React.useEffect(() => {
    if (!result.isFetching && result.isSuccess && result.data) {
      const currentData = result.data;

      // If this is new data (not the same reference as before)
      if (currentData !== previousDataRef.current) {
        previousDataRef.current = currentData;

        // Figure out new items by comparing with what we already have
        if (Array.isArray(currentData)) {
          const currentIds = new Set(currentData.map((item) => item.path));
          const existingIds = new Set(orderedChanges.map((item) => item.path));

          // Filter out items that already exist in orderedChanges
          const newItems = currentData.filter(
            (item) => !existingIds.has(item.path),
          );

          // Filter out items that no longer exist in the API response
          const existingItems = orderedChanges.filter((item) =>
            currentIds.has(item.path),
          );

          // Add new items to the beginning
          setOrderedChanges([...newItems, ...existingItems]);
        } else {
          // If not an array, just use the data directly
          setOrderedChanges([currentData]);
        }
      }
    }
  }, [result.isFetching, result.isSuccess, result.data]);

  return {
    data: orderedChanges,
    isLoading: result.isLoading,
    isFetching: result.isFetching,
    isSuccess: result.isSuccess,
    isError: result.isError,
    error: result.error,
    refetch: result.refetch,
  };
};
