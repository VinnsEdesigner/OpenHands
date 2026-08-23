import React from "react";
import { sendWebSocketAuth } from "#/utils/websocket-auth";
import { startHandshakeWatchdog } from "#/utils/websocket-handshake";

export interface WebSocketHookOptions {
  queryParams?: Record<string, string | boolean>;
  sessionApiKey?: string | null;
  onOpen?: (event: Event) => void;
  onClose?: (event: CloseEvent) => void;
  onMessage?: (event: MessageEvent) => void;
  onError?: (event: Event) => void;
  reconnect?: {
    enabled?: boolean;
    maxAttempts?: number;
  };
}

// Reconnect backoff bounds: 1s, 2s, 4s, … capped at 30s.
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

export const useWebSocket = (url: string, options?: WebSocketHookOptions) => {
  const [isConnected, setIsConnected] = React.useState(false);
  const [error, setError] = React.useState<Error | null>(null);
  const [isReconnecting, setIsReconnecting] = React.useState(false);
  const wsRef = React.useRef<WebSocket | null>(null);
  const attemptCountRef = React.useRef(0);
  const reconnectTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const shouldReconnectRef = React.useRef(true); // Only set to false by disconnect()
  // Track which WebSocket instances are allowed to reconnect using a WeakSet
  const allowedToReconnectRef = React.useRef<WeakSet<WebSocket>>(new WeakSet());
  // Keepalive ping interval ref — prevents the browser from killing the WS
  // when the tab is backgrounded (Chrome/Firefox throttle timers and can
  // drop idle WebSockets after ~5 minutes of inactivity in hidden tabs).
  const keepaliveRef = React.useRef<NodeJS.Timeout | null>(null);
  // Track whether the tab was hidden — used to trigger an immediate
  // reconnect with resend_mode=since when the tab becomes visible again.
  const wasHiddenRef = React.useRef(false);

  // Store options in a ref to avoid reconnecting when callbacks change
  const optionsRef = React.useRef(options);
  React.useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  // --- Visibility-based keepalive and reconnect ---
  // Browsers throttle setTimeout/setInterval in background tabs and may
  // drop idle WebSocket connections. We send a periodic ping (an empty
  // JSON object) to keep the connection alive, and on visibility regain
  // we force an immediate reconnect if the WS dropped while hidden.
  React.useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        wasHiddenRef.current = true;
        // Start sending keepalive pings every 20 seconds while hidden.
        // The server ignores unknown JSON messages gracefully (it tries
        // to parse them as Message and silently drops on failure).
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          keepaliveRef.current = setInterval(() => {
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              try {
                wsRef.current.send(JSON.stringify({ type: "ping" }));
              } catch {
                // Socket may have closed between checks — the onclose
                // handler will trigger reconnection logic.
              }
            }
          }, 20000);
        }
      } else {
        // Tab became visible again.
        if (keepaliveRef.current) {
          clearInterval(keepaliveRef.current);
          keepaliveRef.current = null;
        }
        // If the WS dropped while we were hidden, force an immediate
        // reconnect instead of waiting for the 3-second timer (which may
        // have been throttled and never fired).
        if (wasHiddenRef.current) {
          wasHiddenRef.current = false;
          if (
            shouldReconnectRef.current &&
            (!wsRef.current ||
              wsRef.current.readyState === WebSocket.CLOSED ||
              wsRef.current.readyState === WebSocket.CLOSING)
          ) {
            // Reset attempt count so the reconnect is immediate
            attemptCountRef.current = 0;
            setIsReconnecting(true);
            // Clear any pending throttled timeout
            if (reconnectTimeoutRef.current) {
              clearTimeout(reconnectTimeoutRef.current);
              reconnectTimeoutRef.current = null;
            }
            connectWebSocket();
          }
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (keepaliveRef.current) {
        clearInterval(keepaliveRef.current);
        keepaliveRef.current = null;
      }
    };
  }, []);

  const connectWebSocket = React.useCallback(() => {
    // Build URL with query parameters if provided
    let wsUrl = url;
    if (optionsRef.current?.queryParams) {
      const stringParams = Object.entries(
        optionsRef.current.queryParams,
      ).reduce(
        (acc, [key, value]) => {
          acc[key] = String(value);
          return acc;
        },
        {} as Record<string, string>,
      );
      const params = new URLSearchParams(stringParams);
      wsUrl = `${url}?${params.toString()}`;
    }

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    // Mark this WebSocket instance as allowed to reconnect
    allowedToReconnectRef.current.add(ws);

    // Abort a socket stuck in CONNECTING so it can't hold Chrome's per-host
    // handshake lock indefinitely; its close flows into the reconnect path
    // below.
    const cancelHandshakeWatchdog = startHandshakeWatchdog(ws);

    ws.onopen = (event) => {
      cancelHandshakeWatchdog();
      sendWebSocketAuth(ws, optionsRef.current?.sessionApiKey);
      setIsConnected(true);
      setError(null); // Clear any previous errors
      setIsReconnecting(false);
      attemptCountRef.current = 0; // Reset attempt count on successful connection
      optionsRef.current?.onOpen?.(event);
    };

    ws.onmessage = (event) => {
      // Deliberately no `lastMessage` state here: nothing reads it, and a
      // React state write per frame re-renders this hook's owner on every
      // streamed token. Consumers subscribe via `onMessage`.
      optionsRef.current?.onMessage?.(event);
    };

    ws.onclose = (event) => {
      cancelHandshakeWatchdog();
      // Check if this specific WebSocket instance is allowed to reconnect
      const canReconnect = allowedToReconnectRef.current.has(ws);
      setIsConnected(false);
      // If the connection closes with an error code, treat it as an error
      if (event.code !== 1000) {
        // 1000 is normal closure
        setError(
          new Error(
            `WebSocket closed with code ${event.code}: ${event.reason || "Connection closed unexpectedly"}`,
          ),
        );
        // Also call onError handler for error closures (only if allowed to reconnect)
        if (canReconnect) {
          optionsRef.current?.onError?.(event);
        }
      }
      // Notify the consumer unless this socket was deliberately replaced by a
      // newer one — a replaced socket's close event arrives late and must not
      // clobber the replacement's OPEN state in the consumer. Final closes
      // (disconnect/unmount, nothing replacing the socket) still notify.
      const wasReplaced = wsRef.current !== null && wsRef.current !== ws;
      if (!wasReplaced) {
        optionsRef.current?.onClose?.(event);
      }

      // Attempt reconnection if enabled and allowed
      // IMPORTANT: Only reconnect if this specific instance is allowed to reconnect
      const reconnectEnabled = optionsRef.current?.reconnect?.enabled ?? false;
      const maxAttempts =
        optionsRef.current?.reconnect?.maxAttempts ?? Infinity;

      if (
        reconnectEnabled &&
        canReconnect &&
        shouldReconnectRef.current &&
        attemptCountRef.current < maxAttempts
      ) {
        setIsReconnecting(true);
        attemptCountRef.current += 1;

        // Exponential backoff with up to 30% random jitter so parallel
        // sockets (main + planning) don't retry in lockstep and hammer an
        // already-struggling server every few seconds forever.
        const baseDelay = Math.min(
          RECONNECT_BASE_DELAY_MS * 2 ** (attemptCountRef.current - 1),
          RECONNECT_MAX_DELAY_MS,
        );
        const delay = baseDelay + Math.random() * baseDelay * 0.3;

        reconnectTimeoutRef.current = setTimeout(() => {
          connectWebSocket();
        }, delay);
      } else {
        setIsReconnecting(false);
      }
    };

    ws.onerror = (event) => {
      // Ignore errors from sockets we've deliberately replaced or closed —
      // aborting a mid-handshake socket fires `error`, and it must not
      // surface as a connection failure for the replacement socket.
      if (!allowedToReconnectRef.current.has(ws)) {
        return;
      }
      setIsConnected(false);
      optionsRef.current?.onError?.(event);
    };
  }, [url]);

  React.useEffect(() => {
    // Reset shouldReconnect flag and attempt count when creating a new connection
    shouldReconnectRef.current = true;
    attemptCountRef.current = 0;

    // Only attempt connection if we have a valid URL
    if (url && url.trim() !== "") {
      connectWebSocket();
    }

    return () => {
      // Disable reconnection on unmount to prevent reconnection attempts
      // This must be set BEFORE closing the socket, so the onclose handler sees it
      shouldReconnectRef.current = false;
      // Clear any pending reconnection timeouts
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      // Clear keepalive interval
      if (keepaliveRef.current) {
        clearInterval(keepaliveRef.current);
        keepaliveRef.current = null;
      }
      // Close the WebSocket connection
      if (wsRef.current) {
        const { readyState } = wsRef.current;
        // Remove this WebSocket from the allowed list BEFORE closing
        // so its onclose handler won't try to reconnect
        allowedToReconnectRef.current.delete(wsRef.current);
        // Only close if not already closed/closing
        if (
          readyState === WebSocket.CONNECTING ||
          readyState === WebSocket.OPEN
        ) {
          wsRef.current.close();
        }
        wsRef.current = null;
      }
    };
  }, [url, connectWebSocket]);

  const sendMessage = React.useCallback(
    (data: string | Blob | BufferSource) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(data);
      }
    },
    [],
  );

  const disconnect = React.useCallback(() => {
    shouldReconnectRef.current = false;
    setIsReconnecting(false);
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (keepaliveRef.current) {
      clearInterval(keepaliveRef.current);
      keepaliveRef.current = null;
    }
    if (wsRef.current) {
      // Remove from allowed list before closing
      allowedToReconnectRef.current.delete(wsRef.current);
      wsRef.current.close();
    }
  }, []);

  const reconnect = React.useCallback(() => {
    shouldReconnectRef.current = true;
    attemptCountRef.current = 0;
    setIsReconnecting(true);
    setError(null);

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (wsRef.current) {
      const ws = wsRef.current;
      allowedToReconnectRef.current.delete(ws);
      wsRef.current = null;
      if (
        ws.readyState === WebSocket.CONNECTING ||
        ws.readyState === WebSocket.OPEN
      ) {
        ws.close();
      }
    }

    connectWebSocket();
  }, [connectWebSocket]);

  return {
    isConnected,
    error,
    socket: wsRef.current,
    sendMessage,
    isReconnecting,
    attemptCount: attemptCountRef.current,
    disconnect,
    reconnect,
  };
};
