/**
 * Cloudflare Worker serving the Agent Canvas static SPA plus the same-origin
 * cloud-proxy endpoint.
 *
 * The Canvas is frontend-only, and OpenHands Cloud does not permit CORS from
 * arbitrary origins, so cloud REST calls go through the same-origin
 * `POST /api/cloud-proxy` envelope (see `src/api/cloud/proxy.ts` and
 * `CloudClient.requestThroughProxy`). On a long-lived host that envelope is
 * served by `scripts/relay/cloud-proxy-relay.mjs`; here this Worker covers the
 * one surface the SPA needs and serves every other request from the built
 * static assets. WebSocket streaming is unaffected — the browser connects
 * directly to the per-conversation runtime host (`conversation_url`).
 *
 * Envelope: { host, method, path, headers, body, timeout_seconds? }
 * The Cloud API key is injected server-side so the browser never holds it.
 *
 * Required env: CLOUD_API_KEY
 * Optional env: CLOUD_ORG_ID, CLOUD_HOST (default https://app.all-hands.dev)
 */

const DEFAULT_CLOUD_HOST = "https://app.all-hands.dev";
const DEFAULT_TIMEOUT_MS = 55_000;
const PROXY_PATH = "/api/cloud-proxy";

// Only forward to OpenHands Cloud hosts. Without this the Worker would be an
// open proxy that attaches the account's Bearer token to attacker-chosen URLs.
const ALLOWED_HOST_SUFFIXES = [".all-hands.dev", ".openhands.dev"];

interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  CLOUD_API_KEY?: string;
  CLOUD_ORG_ID?: string;
  CLOUD_HOST?: string;
}

interface ProxyEnvelope {
  host?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout_seconds?: number;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function isAllowedHost(host: string): boolean {
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const hostname = url.hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix),
  );
}

async function handleCloudProxy(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "POST")
    return json({ error: "method_not_allowed" }, 405);

  let envelope: ProxyEnvelope;
  try {
    envelope = (await request.json()) as ProxyEnvelope;
  } catch {
    return json({ error: "bad_request", detail: "invalid envelope" }, 400);
  }

  const targetHost = envelope.host || env.CLOUD_HOST || DEFAULT_CLOUD_HOST;
  if (!isAllowedHost(targetHost)) {
    return json({ error: "host_not_allowed", detail: targetHost }, 400);
  }

  const method = (envelope.method || "GET").toUpperCase();
  const targetUrl = new URL(envelope.path || "/", targetHost);

  const headers: Record<string, string> = {
    ...(envelope.headers ?? {}),
    "x-openhands-client": "agent_canvas",
    host: targetUrl.host,
  };
  // When CLOUD_API_KEY is configured the deployment owns the credential and it
  // is injected here so the browser never holds it (locked-cloud mode, matching
  // `scripts/relay/cloud-proxy-relay.mjs`). Otherwise the key the user entered
  // for the cloud backend in the Canvas UI rides along in the envelope headers.
  if (env.CLOUD_API_KEY) {
    headers.authorization = `Bearer ${env.CLOUD_API_KEY}`;
  }
  const orgId = envelope.headers?.["x-org-id"] || env.CLOUD_ORG_ID;
  if (orgId) headers["x-org-id"] = orgId;

  const hasBody =
    envelope.body !== undefined &&
    envelope.body !== null &&
    ["POST", "PATCH", "PUT"].includes(method);
  if (hasBody) {
    headers["content-type"] = headers["content-type"] || "application/json";
  }

  const timeoutMs = envelope.timeout_seconds
    ? envelope.timeout_seconds * 1000
    : DEFAULT_TIMEOUT_MS;

  try {
    const upstream = await fetch(targetUrl, {
      method,
      headers,
      body: hasBody
        ? typeof envelope.body === "string"
          ? envelope.body
          : JSON.stringify(envelope.body)
        : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const responseHeaders = new Headers();
    const contentType = upstream.headers.get("content-type");
    if (contentType) responseHeaders.set("content-type", contentType);

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return json({ error: "upstream_error", detail }, 502);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === PROXY_PATH) {
      return handleCloudProxy(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
