import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { decrypt, encrypt } from "./crypto.js";

/** Google OAuth tokens persisted per account. Encrypted at rest with AES-256-GCM. */
export interface StoredTokens {
  refresh_token: string;
  access_token?: string;
  expiry_date?: number;
}

export interface AccountRow {
  email: string;
  scopes: string[];
  createdAt: string;
}

export interface PendingOAuthState {
  state: string;
  scopes: string[];
  createdAt: number;
}

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export class TokenStore {
  private db: Database.Database;

  constructor(dbPath: string, private encryptionKey: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        email TEXT PRIMARY KEY,
        scopes TEXT NOT NULL,
        tokens TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY,
        scopes TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  upsertAccount(email: string, scopes: string[], tokens: StoredTokens): void {
    const encrypted = encrypt(JSON.stringify(tokens), this.encryptionKey);
    this.db
      .prepare(
        `INSERT INTO accounts (email, scopes, tokens) VALUES (?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET scopes = excluded.scopes, tokens = excluded.tokens`,
      )
      .run(email.toLowerCase(), JSON.stringify(scopes), encrypted);
  }

  getAccount(email: string): (AccountRow & { tokens: StoredTokens }) | undefined {
    const row = this.db
      .prepare(`SELECT email, scopes, tokens, created_at FROM accounts WHERE email = ?`)
      .get(email.toLowerCase()) as
      | { email: string; scopes: string; tokens: string; created_at: string }
      | undefined;
    if (!row) return undefined;
    return {
      email: row.email,
      scopes: JSON.parse(row.scopes) as string[],
      createdAt: row.created_at,
      tokens: JSON.parse(decrypt(row.tokens, this.encryptionKey)) as StoredTokens,
    };
  }

  /** Merge freshly issued tokens (e.g. refreshed access token) into the stored set. */
  updateTokens(email: string, partial: Partial<StoredTokens>): void {
    const existing = this.getAccount(email);
    if (!existing) return;
    const merged: StoredTokens = { ...existing.tokens, ...stripUndefined(partial) };
    this.upsertAccount(email, existing.scopes, merged);
  }

  listAccounts(): AccountRow[] {
    const rows = this.db
      .prepare(`SELECT email, scopes, created_at FROM accounts ORDER BY created_at`)
      .all() as { email: string; scopes: string; created_at: string }[];
    return rows.map((r) => ({
      email: r.email,
      scopes: JSON.parse(r.scopes) as string[],
      createdAt: r.created_at,
    }));
  }

  removeAccount(email: string): boolean {
    const result = this.db.prepare(`DELETE FROM accounts WHERE email = ?`).run(email.toLowerCase());
    return result.changes > 0;
  }

  createOAuthState(state: string, scopes: string[]): void {
    this.pruneExpiredStates();
    this.db
      .prepare(`INSERT INTO oauth_states (state, scopes, created_at) VALUES (?, ?, ?)`)
      .run(state, JSON.stringify(scopes), Date.now());
  }

  /** Single-use: returns and deletes the state row. Undefined if unknown or expired. */
  consumeOAuthState(state: string): PendingOAuthState | undefined {
    const row = this.db
      .prepare(`SELECT state, scopes, created_at FROM oauth_states WHERE state = ?`)
      .get(state) as { state: string; scopes: string; created_at: number } | undefined;
    if (row) this.db.prepare(`DELETE FROM oauth_states WHERE state = ?`).run(state);
    if (!row || Date.now() - row.created_at > OAUTH_STATE_TTL_MS) return undefined;
    return { state: row.state, scopes: JSON.parse(row.scopes) as string[], createdAt: row.created_at };
  }

  private pruneExpiredStates(): void {
    this.db.prepare(`DELETE FROM oauth_states WHERE created_at < ?`).run(Date.now() - OAUTH_STATE_TTL_MS);
  }

  close(): void {
    this.db.close();
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
