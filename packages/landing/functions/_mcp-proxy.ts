/**
 * Transparent proxy from `lobu.ai/mcp[/*]` to the orgless MCP endpoint on
 * the canonical backend (`app.lobu.ai/mcp[/*]`).
 *
 * Why this exists: `lobu.ai/mcp` is the URL we hand to humans, but the
 * server lives on `app.lobu.ai`. A 3xx redirect doesn't survive MCP's
 * POST + persistent SSE pattern, so we proxy at the edge instead.
 *
 * Browser GETs (Accept: text/html) fall through to the Astro `/mcp` page
 * via `next()`. Everything else — POST, DELETE, OPTIONS, GET with
 * `text/event-stream` — is forwarded upstream with body streaming
 * preserved and a per-request `x-trace-id` for log correlation.
 */

type PagesContext = {
  request: Request;
  next: () => Promise<Response>;
  env: Record<string, unknown>;
  params: Record<string, string | string[]>;
};

const UPSTREAM_ORIGIN_DEFAULT = "https://app.lobu.ai";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  // Cloudflare adds its own; let upstream's response carry through unchanged.
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "x-forwarded-proto",
]);

function prefersHtml(accept: string | null): boolean {
  if (!accept) return false;
  // MCP clients send "application/json, text/event-stream"; browsers send
  // "text/html,...". Treat presence of text/html and absence of SSE as html.
  if (accept.includes("text/event-stream")) return false;
  return accept.includes("text/html");
}

function shouldFallThrough(request: Request): boolean {
  // Only GET (and HEAD, for completeness) can serve a docs page.
  // Anything else is MCP traffic and must proxy.
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (request.headers.get("mcp-session-id")) return false;
  if (request.headers.get("mcp-protocol-version")) return false;
  return prefersHtml(request.headers.get("accept"));
}

function buildUpstreamUrl(request: Request, upstreamOrigin: string): string {
  const incoming = new URL(request.url);
  const upstream = new URL(upstreamOrigin);
  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;
  return upstream.toString();
}

function copyHeaders(
  source: Headers,
  traceId: string,
  originalHost: string
): Headers {
  const out = new Headers();
  for (const [key, value] of source) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    out.set(key, value);
  }
  out.set("x-trace-id", traceId);
  out.set("x-forwarded-host", originalHost);
  out.set("x-forwarded-for-origin", `https://${originalHost}`);
  return out;
}

function logEvent(payload: Record<string, unknown>): void {
  // Structured JSON lands in Workers Logs / Tail / Logpush. Keep it on a
  // single line so log shippers don't fragment it.
  try {
    console.log(JSON.stringify({ source: "lobu.mcp.proxy", ...payload }));
  } catch {
    /* logging must never throw */
  }
}

export async function proxyMcp(context: PagesContext): Promise<Response> {
  const { request, next, env } = context;

  if (shouldFallThrough(request)) {
    return next();
  }

  const upstreamOrigin =
    (typeof env.MCP_UPSTREAM_ORIGIN === "string" && env.MCP_UPSTREAM_ORIGIN) ||
    UPSTREAM_ORIGIN_DEFAULT;

  const incomingUrl = new URL(request.url);
  const traceId =
    request.headers.get("x-trace-id") ??
    (typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2));
  const cfRay = request.headers.get("cf-ray") ?? null;
  const startedAt = Date.now();

  const upstreamUrl = buildUpstreamUrl(request, upstreamOrigin);
  const upstreamHeaders = copyHeaders(
    request.headers,
    traceId,
    incomingUrl.host
  );

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers: upstreamHeaders,
      body:
        request.method === "POST" ||
        request.method === "PUT" ||
        request.method === "PATCH"
          ? request.body
          : undefined,
      // @ts-expect-error — `duplex` is required by the streams spec for
      // request bodies but not yet in lib.dom; Cloudflare Workers honors it.
      duplex: "half",
      redirect: "manual",
    });
  } catch (error) {
    logEvent({
      level: "error",
      traceId,
      cfRay,
      method: request.method,
      path: incomingUrl.pathname,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response(
      JSON.stringify({
        error: "bad_gateway",
        error_description: "MCP upstream unreachable",
        traceId,
      }),
      {
        status: 502,
        headers: {
          "content-type": "application/json",
          "x-trace-id": traceId,
        },
      }
    );
  }

  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.set("x-trace-id", traceId);
  responseHeaders.append(
    "server-timing",
    `mcp_upstream;dur=${Date.now() - startedAt}`
  );

  logEvent({
    traceId,
    cfRay,
    method: request.method,
    path: incomingUrl.pathname,
    upstreamStatus: upstreamResponse.status,
    durationMs: Date.now() - startedAt,
  });

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}
