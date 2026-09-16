import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { summarizeAccess, type AccessLevel } from "../google/auth.js";
import { guarded, jsonResult, textResult, type Deps } from "./util.js";

const accessLevel = z.enum(["none", "readonly", "full"]);

export function registerAccountTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    "list_accounts",
    {
      description:
        "List connected Google accounts and the access each one granted (gmail/calendar: none, readonly, or full).",
      inputSchema: {},
    },
    guarded("list_accounts", async () => {
      const accounts = deps.store.listAccounts().map((a) => ({
        email: a.email,
        access: summarizeAccess(a.scopes),
        connectedAt: a.createdAt,
      }));
      return jsonResult({ accounts });
    }),
  );

  server.registerTool(
    "add_account",
    {
      description:
        "Connect a Google account. Returns an OAuth URL the user must open in a browser to sign in and approve access. " +
        "Choose per service how much access to request: gmail readonly (read mail) or full (read, send, labels, drafts); " +
        "calendar readonly (view events) or full (create/update/respond). At least one service must not be 'none'. " +
        "The link is single-use and expires in 10 minutes.",
      inputSchema: {
        gmail: accessLevel.default("none").describe("Gmail access to request"),
        calendar: accessLevel.default("none").describe("Calendar access to request"),
      },
    },
    guarded("add_account", async (args: { gmail: AccessLevel; calendar: AccessLevel }) => {
      if (args.gmail === "none" && args.calendar === "none") {
        throw new Error("Request access to at least one service (gmail and/or calendar).");
      }
      const url = deps.auth.createAuthUrl({ gmail: args.gmail, calendar: args.calendar });
      return textResult(
        `Open this URL in a browser, sign in with the Google account to connect, and approve the requested access:\n\n${url}\n\n` +
          `The link is single-use and expires in 10 minutes. After approval, the account appears in list_accounts.`,
      );
    }),
  );

  server.registerTool(
    "remove_account",
    {
      description:
        "Disconnect a Google account: deletes its stored tokens from this server. " +
        "To also revoke the grant on Google's side, visit myaccount.google.com/permissions.",
      inputSchema: {
        account: z.string().describe("Email address of the connected account to remove"),
      },
    },
    guarded("remove_account", async (args: { account: string }) => {
      const removed = deps.store.removeAccount(args.account);
      if (!removed) throw new Error(`No connected account "${args.account}".`);
      return textResult(
        `Removed ${args.account}. Its tokens are deleted from this server. ` +
          `To revoke the grant on Google's side too, visit https://myaccount.google.com/permissions.`,
      );
    }),
  );
}
