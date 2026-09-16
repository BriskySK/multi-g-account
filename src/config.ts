import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  /** Public base URL of this server, e.g. https://mcp.example.com */
  PUBLIC_URL: z.string().url(),
  /** Shared secret Claude sends in request headers to authenticate to this server */
  MCP_API_KEY: z.string().min(32, "MCP_API_KEY must be at least 32 characters"),
  /** 32-byte key as 64 hex chars; encrypts Google tokens at rest (AES-256-GCM) */
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "TOKEN_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)"),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  DB_PATH: z.string().default("./data/multi-g-account.db"),
});

export type Config = z.infer<typeof EnvSchema> & { redirectUri: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(env)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}\nSee .env.example for required variables.`);
  }
  const cfg = parsed.data;
  return { ...cfg, redirectUri: new URL("/oauth/callback", cfg.PUBLIC_URL).toString() };
}
