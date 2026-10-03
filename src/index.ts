import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { EdgClient } from "./edg.js";
import { buildServer } from "./server.js";

export interface Env {
  /** EDG API access token (Bearer). Secret. */
  EDG_TOKEN: string;
  /** Shared secret protecting this MCP endpoint. Secret. */
  MCP_AUTH_TOKEN: string;
  /** Optional override, mostly for tests. */
  EDG_API_URL?: string;
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * Accepts the shared secret as `Authorization: Bearer <token>` or as the last
 * path segment (`/mcp/<token>`), because some MCP clients (e.g. claude.ai
 * custom connectors without OAuth) only let you configure a URL.
 */
export function isAuthorized(req: Request, env: Env): boolean {
  if (!env.MCP_AUTH_TOKEN) return false;
  const header = req.headers.get("authorization");
  if (header?.startsWith("Bearer ") && timingSafeEqual(header.slice(7), env.MCP_AUTH_TOKEN)) return true;
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  return parts.length === 2 && parts[0] === "mcp" && timingSafeEqual(parts[1], env.MCP_AUTH_TOKEN);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (pathname === "/" || pathname === "/health") {
      return Response.json({ ok: true, name: "edg-mcp" });
    }

    if (pathname !== "/mcp" && !pathname.startsWith("/mcp/")) {
      return new Response("Not found", { status: 404 });
    }

    if (!isAuthorized(req, env)) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Stateless: a fresh server + transport per request.
    const client = new EdgClient({ token: env.EDG_TOKEN, apiUrl: env.EDG_API_URL });
    const server = buildServer(client);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(req);
  },
} satisfies ExportedHandler<Env>;
