/**
 * Vercel serverless port of the cloud-proxy relay's `forwardToCloud`.
 *
 * The Canvas SPA is frontend-only, and OpenHands Cloud does not permit CORS
 * from arbitrary origins, so cloud REST calls go through the same-origin
 * `POST /api/cloud-proxy` envelope (see `src/api/cloud/proxy.ts` and
 * `CloudClient.requestThroughProxy`). On a long-lived host that envelope is
 * served by `scripts/relay/cloud-proxy-relay.mjs`; on Vercel there is no
 * long-lived server, so this single function covers the one surface the SPA
 * needs. WebSocket streaming is unaffected — the browser connects directly to
 * the per-conversation runtime host (`conversation_url`).
 *
 * Request body (envelope):
 *   { host, method, path, headers, body, timeout_seconds? }
 *
 * The Cloud API key is injected server-side so the browser never holds it.
 *
 * Required env: CLOUD_API_KEY
 * Optional env: CLOUD_ORG_ID, CLOUD_HOST (default https://app.all-hands.dev)
 */

const DEFAULT_CLOUD_HOST = "https://app.all-hands.dev";
const DEFAULT_TIMEOUT_MS = 55_000;

// Only forward to OpenHands Cloud hosts. Without this the function would be an
// open proxy that attaches the account's Bearer token to attacker-chosen URLs.
const ALLOWED_HOST_SUFFIXES = [".all-hands.dev", ".openhands.dev"];

interface ProxyEnvelope {
  host?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout_seconds?: number;
}

interface ApiRequest {
  method?: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

interface ApiResponse {
  status: (code: number) => ApiResponse;
  setHeader: (name: string, value: string) => void;
  send: (body: unknown) => void;
  end: (body?: unknown) => void;
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

function parseEnvelope(body: unknown): ProxyEnvelope | null {
  if (!body) return null;
  if (typeof body === "string") {
    try {
      return JSON.parse(body) as ProxyEnvelope;
    } catch {
      return null;
    }
  }
  if (typeof body === "object") return body as ProxyEnvelope;
  return null;
}

export default async function handler(
  req: ApiRequest,
  res: ApiResponse,
): Promise<void> {
  res.setHeader("cache-control", "no-store");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).send({ error: "method_not_allowed" });
    return;
  }

  const cloudApiKey = process.env.CLOUD_API_KEY;
  if (!cloudApiKey) {
    res
      .status(500)
      .send({ error: "config_error", detail: "CLOUD_API_KEY is not set" });
    return;
  }

  const envelope = parseEnvelope(req.body);
  if (!envelope) {
    res.status(400).send({ error: "bad_request", detail: "invalid envelope" });
    return;
  }

  const targetHost =
    envelope.host || process.env.CLOUD_HOST || DEFAULT_CLOUD_HOST;
  if (!isAllowedHost(targetHost)) {
    res.status(400).send({ error: "host_not_allowed", detail: targetHost });
    return;
  }

  const method = (envelope.method || "GET").toUpperCase();
  const targetUrl = new URL(envelope.path || "/", targetHost);

  const upstreamHeaders: Record<string, string> = {
    ...(envelope.headers ?? {}),
    authorization: `Bearer ${cloudApiKey}`,
    "x-openhands-client": "agent_canvas",
    host: targetUrl.host,
  };
  const orgId = envelope.headers?.["x-org-id"] || process.env.CLOUD_ORG_ID;
  if (orgId) upstreamHeaders["x-org-id"] = orgId;

  const hasBody =
    envelope.body !== undefined &&
    envelope.body !== null &&
    ["POST", "PATCH", "PUT"].includes(method);
  if (hasBody) {
    upstreamHeaders["content-type"] =
      upstreamHeaders["content-type"] || "application/json";
  }

  const timeoutMs = envelope.timeout_seconds
    ? envelope.timeout_seconds * 1000
    : DEFAULT_TIMEOUT_MS;

  try {
    const upstream = await fetch(targetUrl, {
      method,
      headers: upstreamHeaders,
      body: hasBody
        ? typeof envelope.body === "string"
          ? envelope.body
          : JSON.stringify(envelope.body)
        : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const contentType = upstream.headers.get("content-type");
    if (contentType) res.setHeader("content-type", contentType);

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status).send(buffer);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    res.status(502).send({ error: "upstream_error", detail });
  }
}
