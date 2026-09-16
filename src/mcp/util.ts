import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../config.js";
import type { TokenStore } from "../db.js";
import type { GoogleAuthService } from "../google/auth.js";

export interface Deps {
  config: Config;
  store: TokenStore;
  auth: GoogleAuthService;
}

export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorMessage(err: unknown): string {
  const anyErr = err as { response?: { data?: { error?: { message?: string } | string } }; message?: string };
  const apiError = anyErr?.response?.data?.error;
  if (typeof apiError === "string") return apiError;
  if (apiError?.message) return apiError.message;
  return anyErr?.message ?? String(err);
}

/**
 * Wraps a tool handler: catches errors into isError results and writes an audit
 * line (tool name, account, outcome — never message/event content).
 */
export function guarded<A>(
  tool: string,
  handler: (args: A) => Promise<CallToolResult>,
): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    const account = (args as { account?: string } | undefined)?.account;
    const startedAt = Date.now();
    try {
      const result = await handler(args);
      audit({ tool, account, ok: true, ms: Date.now() - startedAt });
      return result;
    } catch (err) {
      audit({ tool, account, ok: false, ms: Date.now() - startedAt });
      return {
        content: [{ type: "text", text: `Error: ${errorMessage(err)}` }],
        isError: true,
      };
    }
  };
}

function audit(entry: { tool: string; account?: string; ok: boolean; ms: number }): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event: "tool_call", ...entry }));
}
