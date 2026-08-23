import React from "react";
import { useLocation } from "react-router";
import { ConversationWebSocketProvider } from "#/contexts/conversation-websocket-context";
import { WebSocketProviderWrapper } from "#/contexts/websocket-provider-wrapper";
import { usePaginatedConversations } from "#/hooks/query/use-paginated-conversations";
import { useUserConversation } from "#/hooks/query/use-user-conversation";
import { useSubConversations } from "#/hooks/query/use-sub-conversations";
import { isExecutionActive } from "#/utils/status";
import type { AppConversation } from "#/api/conversation-service/agent-server-conversation-service.types";

/**
 * Determines if a conversation needs a live WebSocket connection.
 * Only actively-running conversations need live event streaming —
 * stopped/errored conversations don't produce new events.
 */
function needsConnection(conv: AppConversation): boolean {
  return isExecutionActive(conv.execution_status);
}

/**
 * Background connection that keeps a WebSocket alive for a single conversation
 * even when the user is not viewing it. This is a "headless" provider — it
 * renders no children, just maintains the WS connection so the server's
 * pub/sub has an active subscriber (preventing idle sandbox eviction).
 */
function BackgroundConversationConnection({
  conversationId,
}: {
  conversationId: string;
}) {
  const { data: conversation } = useUserConversation(conversationId);
  const { data: subConversations } = useSubConversations(
    conversation?.sub_conversation_ids ?? [],
  );

  const filteredSubConversations = subConversations?.filter(
    (sub) => sub !== null,
  );

  const conversationUrl =
    conversation?.sandbox_status === "PAUSED"
      ? null
      : conversation?.conversation_url;

  return (
    <ConversationWebSocketProvider
      conversationId={conversationId}
      conversationUrl={conversationUrl}
      sessionApiKey={conversation?.session_api_key}
      subConversationIds={conversation?.sub_conversation_ids}
      subConversations={filteredSubConversations}
    >
      <></>
    </ConversationWebSocketProvider>
  );
}

/**
 * Manages WebSocket connections for ALL active conversations, not just the
 * one currently being viewed. This prevents sandbox idle eviction when the
 * user navigates away from a conversation page.
 *
 * Architecture:
 * - The conversation list is polled every 10s (via usePaginatedConversations)
 * - For each conversation with an active execution_status, a background WS
 *   connection is maintained
 * - The currently-viewed conversation gets a foreground WS provider
 *   (via WebSocketProviderWrapper) that routes events to the UI stores
 * - Background conversations get a headless WS provider that just keeps
 *   the subscriber alive on the server
 */
function ConversationConnectionManager({
  children,
}: {
  children: React.ReactNode;
}) {
  const location = useLocation();
  const urlConversationId =
    location.pathname.match(/^\/conversations\/([^/]+)/)?.[1] ?? null;

  const { data: conversationsData } = usePaginatedConversations(50);

  const allConversations: AppConversation[] =
    conversationsData?.pages?.flatMap((p) => p.items ?? []) ?? [];

  // Background connections: all active conversations EXCEPT the one being viewed
  const backgroundConversationIds = allConversations
    .filter(
      (conv) =>
        conv.id &&
        needsConnection(conv) &&
        conv.id !== urlConversationId,
    )
    .map((conv) => conv.id)
    .filter((id, idx, arr) => arr.indexOf(id) === idx);

  return (
    <>
      {/* Foreground: WS for the currently-viewed conversation (routes events to UI) */}
      {urlConversationId ? (
        <WebSocketProviderWrapper conversationId={urlConversationId}>
          {children}
        </WebSocketProviderWrapper>
      ) : (
        children
      )}

      {/* Background: headless WS connections for all other running conversations */}
      {backgroundConversationIds.map((id) => (
        <BackgroundConversationConnection key={id} conversationId={id} />
      ))}
    </>
  );
}

/**
 * Wraps the app Outlet with a multi-conversation WebSocket manager that
 * maintains WS connections for ALL running conversations, regardless of
 * which page the user is on.
 */
export function PersistentWebSocketProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ConversationConnectionManager>{children}</ConversationConnectionManager>;
}
