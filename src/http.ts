import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./mcp/server.js";
import type { Deps } from "./mcp/util.js";

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function apiKeyAuth(expectedKey: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    const provided = bearer ?? (req.headers["x-api-key"] as string | undefined);
    if (!provided || !constantTimeEquals(provided, expectedKey)) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: provide the API key as 'Authorization: Bearer <key>' or 'x-api-key' header." },
        id: null,
      });
      return;
    }
    next();
  };
}

export function createApp(deps: Deps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  // Caddy sits in front; trust exactly one proxy hop so rate limiting keys on the real client IP.
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "4mb" }));

  const mcpLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });
  const oauthLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // Stateless Streamable HTTP: a fresh server + transport per request, torn down when the response closes.
  app.post("/mcp", mcpLimiter, apiKeyAuth(deps.config.MCP_API_KEY), async (req, res) => {
    const server = buildMcpServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), event: "mcp_error", message: (err as Error).message }));
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Stateless mode has no server-initiated streams or sessions to resume/terminate.
  const methodNotAllowed = (_req: Request, res: Response): void => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. This server runs in stateless mode; use POST /mcp." },
      id: null,
    });
  };
  app.get("/mcp", mcpLimiter, methodNotAllowed);
  app.delete("/mcp", mcpLimiter, methodNotAllowed);

  // Google redirects the user's browser here after consent. No API key: authenticity comes
  // from the single-use `state` parameter created by add_account.
  app.get("/oauth/callback", oauthLimiter, async (req, res) => {
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
    if (error) {
      res.status(400).send(page("Connection failed", `Google returned an error: ${escapeHtml(error)}.`));
      return;
    }
    if (!code || !state) {
      res.status(400).send(page("Connection failed", "Missing code or state parameter."));
      return;
    }
    try {
      const result = await deps.auth.handleCallback(code, state);
      const services = [
        result.access.gmail !== "none" ? `Gmail (${result.access.gmail})` : null,
        result.access.calendar !== "none" ? `Calendar (${result.access.calendar})` : null,
      ]
        .filter(Boolean)
        .join(", ");
      console.log(JSON.stringify({ ts: new Date().toISOString(), event: "account_connected", account: result.email }));
      res.send(
        page(
          "Account connected",
          `${escapeHtml(result.email)} is connected with access to: ${escapeHtml(services || "nothing (no scopes granted)")}. You can close this tab and return to Claude.`,
        ),
      );
    } catch (err) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), event: "oauth_error", message: (err as Error).message }));
      res.status(400).send(page("Connection failed", escapeHtml((err as Error).message)));
    }
  });

  return app;
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;color:#222}h1{font-size:1.3rem}</style></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
