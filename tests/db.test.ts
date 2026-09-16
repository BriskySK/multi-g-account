import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenStore } from "../src/db.js";

const KEY = "c".repeat(64);

describe("TokenStore", () => {
  let store: TokenStore;

  beforeEach(() => {
    store = new TokenStore(":memory:", KEY);
  });

  afterEach(() => {
    store.close();
    vi.useRealTimers();
  });

  it("stores and retrieves an account with decrypted tokens", () => {
    store.upsertAccount("Alice@Example.com", ["scope-a"], { refresh_token: "rt-1", access_token: "at-1" });
    const account = store.getAccount("alice@example.com");
    expect(account?.email).toBe("alice@example.com");
    expect(account?.scopes).toEqual(["scope-a"]);
    expect(account?.tokens).toEqual({ refresh_token: "rt-1", access_token: "at-1" });
  });

  it("upsert replaces scopes and tokens", () => {
    store.upsertAccount("a@b.c", ["one"], { refresh_token: "rt-1" });
    store.upsertAccount("a@b.c", ["two"], { refresh_token: "rt-2" });
    const account = store.getAccount("a@b.c");
    expect(account?.scopes).toEqual(["two"]);
    expect(account?.tokens.refresh_token).toBe("rt-2");
    expect(store.listAccounts()).toHaveLength(1);
  });

  it("updateTokens merges without dropping the refresh token", () => {
    store.upsertAccount("a@b.c", ["one"], { refresh_token: "rt-1", access_token: "old" });
    store.updateTokens("a@b.c", { access_token: "new", expiry_date: 123, refresh_token: undefined });
    expect(store.getAccount("a@b.c")?.tokens).toEqual({ refresh_token: "rt-1", access_token: "new", expiry_date: 123 });
  });

  it("removeAccount deletes and reports absence", () => {
    store.upsertAccount("a@b.c", [], { refresh_token: "rt" });
    expect(store.removeAccount("a@b.c")).toBe(true);
    expect(store.removeAccount("a@b.c")).toBe(false);
    expect(store.getAccount("a@b.c")).toBeUndefined();
  });

  it("oauth state is single-use", () => {
    store.createOAuthState("state-1", ["s"]);
    expect(store.consumeOAuthState("state-1")?.scopes).toEqual(["s"]);
    expect(store.consumeOAuthState("state-1")).toBeUndefined();
  });

  it("oauth state expires after 10 minutes", () => {
    vi.useFakeTimers();
    store.createOAuthState("state-2", ["s"]);
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(store.consumeOAuthState("state-2")).toBeUndefined();
  });

  it("tokens are not stored in plaintext", () => {
    const raw = new TokenStore(":memory:", KEY);
    raw.upsertAccount("a@b.c", [], { refresh_token: "super-secret-refresh-token" });
    // Read the raw column through a second connection-less check: re-open via any-cast.
    const db = (raw as unknown as { db: import("better-sqlite3").Database }).db;
    const row = db.prepare("SELECT tokens FROM accounts").get() as { tokens: string };
    expect(row.tokens).not.toContain("super-secret-refresh-token");
    raw.close();
  });
});
