# multi-g-account

Self-hosted **MCP server for multiple Google accounts** — Gmail and Google Calendar for every connected account, exposed to Claude as a single custom connector. Unlike the built-in connectors (one account, one service), this holds any number of accounts side by side, each with its own permission level.

- **Multi-account**: connect personal + work + any other Google accounts; every tool takes an `account` parameter.
- **Per-account scopes**: each account grants exactly what you choose — Gmail readonly or full, Calendar readonly or full, or only one of the two services.
- **Self-hosted**: your tokens live encrypted (AES-256-GCM) in a SQLite file on your own server. Each deployment uses its **own** Google Cloud OAuth client — nothing is shared with anyone.
- **Secure by default**: API-key auth on the MCP endpoint, HTTPS via Caddy/Let's Encrypt, rate limiting, single-use CSRF-protected OAuth states, audit log without message content.

## Tools

| Area | Tools |
|------|-------|
| Accounts | `list_accounts`, `add_account`, `remove_account` |
| Gmail | `gmail_search_threads`, `gmail_get_message`, `gmail_get_thread`, `gmail_send_message`, `gmail_create_draft`, `gmail_list_labels`, `gmail_label_message` |
| Calendar | `calendar_list_calendars`, `calendar_list_events`, `calendar_search_events`, `calendar_create_event`, `calendar_update_event`, `calendar_delete_event`, `calendar_respond_to_event` |

## Quick start (local development)

```bash
npm install
cp .env.example .env   # fill in the values — see the two setup sections below
npm run dev
```

The server listens on `http://localhost:3000` with endpoints `/mcp` (MCP, API-key protected), `/oauth/callback` (Google redirect target), and `/healthz`.

Generate the two secrets:

```bash
openssl rand -base64 48   # → MCP_API_KEY
openssl rand -hex 32      # → TOKEN_ENCRYPTION_KEY
```

## 1. Google Cloud OAuth setup

Every deployment needs its own OAuth client. In **Testing** mode no app verification is required — you just add your own Google accounts as test users.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → top project dropdown → **New Project** → any name → **Create**. Select it once created.
2. Enable the two APIs via direct links (skip the search box — it also lists unrelated "Gmail MCP API" / "Gmail Postmaster API" results):
   - [Enable Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com) → click **Enable**.
   - [Enable Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com) → click **Enable**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External** → **Create**.
   - App name: anything (e.g. `multi-g-account`). User support email: your email. Developer contact email: your email. Leave everything else blank/default → **Create**.
   - Publishing status must stay **Testing** (do not click "Publish App").
   - In the **left sidebar under APIs & Services**, click **Audience** (a separate page from the consent-screen form you just filled — test users moved here in the current console). Scroll to **Test users** → **+ Add users** → enter the email of *every* Google account you want to connect (including your own) → **Save**. Only these addresses can complete OAuth while the app is in Testing.
4. **APIs & Services → Credentials** → **+ Create Credentials** → **OAuth client ID**:
   - Application type: **Web application**. Name: anything.
   - Under **Authorized redirect URIs** click **+ Add URI** and add, exactly:
     - `http://localhost:3000/oauth/callback` (local dev)
     - `https://YOUR_DOMAIN/oauth/callback` (prod — replace `YOUR_DOMAIN` with your real domain; must equal `PUBLIC_URL` from `.env` plus `/oauth/callback`, character for character, no trailing slash)
   - Click **Create**.
5. A dialog shows **Client ID** and **Client secret** — copy both immediately into `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. (You can also re-open them later from the Credentials page.)

> Signing in shows a "Google hasn't verified this app" warning — expected in Testing mode. Click *Continue*. Refresh tokens for test-mode apps are long-lived for test users but can be revoked by Google after 6 months of inactivity; reconnecting with `add_account` fixes that.

## 2. Deploy on your own domain

Any VPS with a public IP works (a small instance is plenty — Node + SQLite).

1. **DNS**: create an `A` record, e.g. `mcp.yourdomain.com` → your VPS IP.
2. **Firewall**: allow only 80 (Let's Encrypt challenge), 443, and your SSH port.
3. **Install** Docker + Docker Compose on the VPS, clone this repo, and create `.env` from `.env.example` (set `PUBLIC_URL=https://mcp.yourdomain.com` and `MCP_DOMAIN=mcp.yourdomain.com`).
4. **Run**:

```bash
docker compose up -d --build
```

Caddy obtains and renews the Let's Encrypt certificate automatically; the Node app is reachable only through Caddy. Verify with:

```bash
curl https://mcp.yourdomain.com/healthz
```

5. **Backups**: the `./data` directory holds the SQLite file with your (encrypted) tokens. Back it up regularly to somewhere off the VPS. Without `TOKEN_ENCRYPTION_KEY` from `.env` the backup is useless to an attacker — and to you, so back up your `.env` secrets separately and safely.

## 3. Connect to Claude

1. Claude → **Settings → Connectors → Add custom connector**.
2. URL: `https://mcp.yourdomain.com/mcp`.
3. Under advanced/header settings, add the API key header: `Authorization: Bearer <your MCP_API_KEY>` (or `x-api-key: <key>`).
4. In a chat, ask Claude to run `add_account` (e.g. "connect my Gmail with full access and calendar readonly"). Open the returned URL in your browser, sign in, approve. The account is now available to every tool via its email address.

Repeat `add_account` for each additional Google account.

## Security model

- **Server auth**: every `/mcp` request must carry the API key; comparison is constant-time. `/oauth/callback` is protected by single-use, 10-minute-TTL `state` values instead.
- **Token storage**: Google refresh/access tokens are encrypted with AES-256-GCM before touching disk; the key lives only in the environment. Tampered ciphertexts fail authentication and are rejected.
- **Scopes**: requested per account and per service, at the level you choose (`readonly` vs `full`); tools verify granted scopes before every call and fail with a clear message instead of escalating.
- **Transport**: HTTPS-only via Caddy; the app container has no published ports.
- **Rate limiting**: per-IP limits on `/mcp` and `/oauth/*`.
- **Audit log**: every tool call logs tool name, account, outcome, and duration to stdout — never message bodies, subjects, or event contents.
- **Revocation**: `remove_account` deletes stored tokens; revoke the Google-side grant at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

Found a vulnerability? Please open a private report rather than a public issue.

## Development

```bash
npm run dev        # tsx watch mode
npm run build      # compile to dist/
npm test           # vitest
npm run typecheck  # tsc --noEmit
```

Stack: TypeScript, [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) (Streamable HTTP, stateless mode), `googleapis`, Express, `better-sqlite3`.

## License

MIT
