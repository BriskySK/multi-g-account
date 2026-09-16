import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "../src/crypto.js";

const KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);

describe("crypto", () => {
  it("round-trips utf8 plaintext", () => {
    const plaintext = 'refresh token 🗝️ {"json": true}';
    expect(decrypt(encrypt(plaintext, KEY), KEY)).toBe(plaintext);
  });

  it("produces a different ciphertext each call (random IV)", () => {
    expect(encrypt("same", KEY)).not.toBe(encrypt("same", KEY));
  });

  it("rejects a tampered payload", () => {
    const payload = encrypt("secret", KEY);
    const raw = Buffer.from(payload, "base64");
    raw[raw.length - 1]! ^= 0xff;
    expect(() => decrypt(raw.toString("base64"), KEY)).toThrow();
  });

  it("rejects the wrong key", () => {
    expect(() => decrypt(encrypt("secret", KEY), OTHER_KEY)).toThrow();
  });
});
