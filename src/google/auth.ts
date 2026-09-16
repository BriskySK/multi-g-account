import { randomBytes } from "node:crypto";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type { Config } from "../config.js";
import type { TokenStore } from "../db.js";

export type AccessLevel = "none" | "readonly" | "full";

export interface RequestedAccess {
  gmail: AccessLevel;
  calendar: AccessLevel;
}

/** Always requested so the callback can identify which Google account was connected. */
const BASE_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email"];

const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";
const CALENDAR_READONLY = "https://www.googleapis.com/auth/calendar.readonly";
const CALENDAR_FULL = "https://www.googleapis.com/auth/calendar";

export function scopesForAccess(access: RequestedAccess): string[] {
  const scopes = [...BASE_SCOPES];
  if (access.gmail === "readonly") scopes.push(GMAIL_READONLY);
  // gmail.modify covers read + labels + trash; gmail.send is a separate scope.
  if (access.gmail === "full") scopes.push(GMAIL_MODIFY, GMAIL_SEND);
  if (access.calendar === "readonly") scopes.push(CALENDAR_READONLY);
  if (access.calendar === "full") scopes.push(CALENDAR_FULL);
  return scopes;
}

export function summarizeAccess(grantedScopes: string[]): RequestedAccess {
  const has = (s: string) => grantedScopes.includes(s);
  return {
    gmail: has(GMAIL_MODIFY) || has(GMAIL_SEND) ? "full" : has(GMAIL_READONLY) ? "readonly" : "none",
    calendar: has(CALENDAR_FULL) ? "full" : has(CALENDAR_READONLY) ? "readonly" : "none",
  };
}

export type Capability = "gmail_read" | "gmail_send" | "gmail_modify" | "calendar_read" | "calendar_write";

const CAPABILITY_SCOPES: Record<Capability, string[]> = {
  gmail_read: [GMAIL_READONLY, GMAIL_MODIFY],
  gmail_send: [GMAIL_SEND],
  gmail_modify: [GMAIL_MODIFY],
  calendar_read: [CALENDAR_READONLY, CALENDAR_FULL],
  calendar_write: [CALENDAR_FULL],
};

export class GoogleAuthService {
  constructor(
    private config: Config,
    private store: TokenStore,
  ) {}

  private newOAuthClient(): OAuth2Client {
    return new google.auth.OAuth2(
      this.config.GOOGLE_CLIENT_ID,
      this.config.GOOGLE_CLIENT_SECRET,
      this.config.redirectUri,
    );
  }

  /** Creates a single-use OAuth URL. State is persisted and verified in the callback (CSRF protection). */
  createAuthUrl(access: RequestedAccess): string {
    const scopes = scopesForAccess(access);
    const state = randomBytes(32).toString("base64url");
    this.store.createOAuthState(state, scopes);
    return this.newOAuthClient().generateAuthUrl({
      access_type: "offline",
      prompt: "consent", // force refresh_token issuance even on re-connect
      scope: scopes,
      state,
    });
  }

  /** Exchanges the authorization code, identifies the account, persists encrypted tokens. */
  async handleCallback(code: string, state: string): Promise<{ email: string; access: RequestedAccess }> {
    const pending = this.store.consumeOAuthState(state);
    if (!pending) {
      throw new Error("Invalid or expired OAuth state. Start again with the add_account tool.");
    }
    const client = this.newOAuthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error("Google did not return a refresh token. Remove the app's access at myaccount.google.com/permissions and try again.");
    }
    client.setCredentials(tokens);

    const userinfo = await google.oauth2({ version: "v2", auth: client }).userinfo.get();
    const email = userinfo.data.email;
    if (!email) throw new Error("Could not determine the email address of the connected Google account.");

    const grantedScopes = (tokens.scope ?? pending.scopes.join(" ")).split(" ").filter(Boolean);
    this.store.upsertAccount(email, grantedScopes, {
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token ?? undefined,
      expiry_date: tokens.expiry_date ?? undefined,
    });
    return { email: email.toLowerCase(), access: summarizeAccess(grantedScopes) };
  }

  /**
   * Returns an authenticated OAuth2 client for a connected account, verifying it has
   * the scopes the calling tool needs. Refreshed access tokens are persisted automatically.
   */
  getClientFor(accountEmail: string, needs: Capability[]): OAuth2Client {
    const account = this.store.getAccount(accountEmail);
    if (!account) {
      const known = this.store.listAccounts().map((a) => a.email);
      throw new Error(
        `No connected account "${accountEmail}". Connected accounts: ${known.length ? known.join(", ") : "(none)"}. Use add_account to connect one.`,
      );
    }
    for (const capability of needs) {
      const accepted = CAPABILITY_SCOPES[capability];
      if (!account.scopes.some((s) => accepted.includes(s))) {
        throw new Error(
          `Account "${account.email}" was not granted ${capability} access. Reconnect it with add_account and approve the required permissions.`,
        );
      }
    }
    const client = this.newOAuthClient();
    client.setCredentials({
      refresh_token: account.tokens.refresh_token,
      access_token: account.tokens.access_token,
      expiry_date: account.tokens.expiry_date,
    });
    client.on("tokens", (fresh) => {
      this.store.updateTokens(account.email, {
        access_token: fresh.access_token ?? undefined,
        expiry_date: fresh.expiry_date ?? undefined,
        refresh_token: fresh.refresh_token ?? undefined,
      });
    });
    return client;
  }
}
