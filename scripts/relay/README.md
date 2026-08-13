# Cloud proxy relay

Self-host the Agent Canvas UI while driving the closed-source OpenHands Cloud
agent server (`app.all-hands.dev` / `*.prod-runtime.all-hands.dev`) — including
its free LLMs — without running an OSS agent server locally.

## Why this exists

The Canvas talks to OpenHands Cloud in two ways:

1. **REST** — through the same-origin `POST /api/cloud-proxy` envelope (see
   `src/api/cloud/proxy.ts` and `callCloudProxy` in the frontend). The cloud
   host does not permit CORS from `localhost`, so these calls must be
   forwarded server-side.
2. **WebSocket streaming** — directly to the per-conversation cloud runtime
   sandbox (`conversation.conversation_url`), which carries
   `StreamingDeltaEvent`s token-by-token.

`cloud-proxy-relay.mjs` is that server-side forwarder. It injects the Cloud API
key (`Authorization: Bearer`) and org id (`X-Org-Id`) so the browser never holds
the credential, and optionally also serves the Canvas static build and/or
reverse-proxies an OSS agent server — letting it sit directly in front of the
Canvas as a single ingress.

## Files

- `cloud-proxy-relay.mjs` — the relay server.
- `ws-streaming-test.mjs` — diagnostic: connects to a cloud runtime sandbox
  WebSocket, sends a message via REST, and confirms `StreamingDeltaEvent`s flow
  token-by-token (used to verify the free model streams end-to-end).

## Pure-cloud quickstart (Canvas + relay only, no OSS agent server)

```bash
CLOUD_API_KEY=<key> CLOUD_ORG_ID=<org-uuid> \
STATIC_DIR=<path-to-canvas-build> \
AGENT_SERVER_URL="" \
PORT=18080 \
node scripts/relay/cloud-proxy-relay.mjs
```

With `STATIC_DIR` set the relay serves the Canvas SPA (SPA fallback to
`index.html`), handles `POST /api/cloud-proxy` → Cloud, and — because
`AGENT_SERVER_URL=""` disables it — returns a clear `503
agent_server_not_configured` for any local-protocol path (`/api`, `/sockets`,
`/server_info`, …) instead of a misleading `502`. The Canvas cloud path does
not use those prefixes, so this never fires in a correctly-wired cloud setup.

## Local mode (relay + OSS agent server)

If you also run an OSS agent server, point `AGENT_SERVER_URL` at it and the
relay reverse-proxies `/api`, `/sockets`, `/server_info`, `/health`, `/alive`,
`/openapi.json`, `/docs`, `/redoc`, `/ready` to it:

```bash
CLOUD_API_KEY=<key> CLOUD_ORG_ID=<org-uuid> \
STATIC_DIR=<path-to-canvas-build> \
AGENT_SERVER_URL=http://127.0.0.1:18000 \
PORT=18080 \
node scripts/relay/cloud-proxy-relay.mjs
```

Unset / a real URL = enabled; `""`, `none`, `off`, `disabled` = disabled.

## Environment

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `CLOUD_API_KEY` | yes | — | Cloud API key (injected as `Bearer` server-side) |
| `CLOUD_ORG_ID` | yes | — | Org UUID (sent as `X-Org-Id`) |
| `CLOUD_HOST` | no | `https://app.all-hands.dev` | Cloud host |
| `PORT` | no | `18080` | Relay listen port |
| `ALLOW_ORIGIN` | no | `*` | CORS origin |
| `PROXY_KEY` | no | — | Optional `X-Session-API-Key` the relay itself requires |
| `AGENT_SERVER_URL` | no | `http://127.0.0.1:18000` | OSS agent server; `""`/`none` to disable |
| `STATIC_DIR` | no | — | Serve the Canvas static build (SPA fallback) |

## Relationship to the other canvas servers

This relay is an alternative ingress for the **cloud-backend** use case. The
repo's other servers (`scripts/static-server.mjs`, `scripts/ingress.mjs`) are
for the **local-backend** stack (`npx @openhands/agent-canvas`, see
`docs/SELF_HOSTING.md`) where an OSS agent server runs on the host. Use the
relay when you want the Canvas UI self-hosted but the agent/LLM running on
OpenHands Cloud.
