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
openssl rand -hex 32   # → MCP_API_KEY
openssl rand -hex 32   # → TOKEN_ENCRYPTION_KEY
```

> Use `hex`, not `base64`, for `MCP_API_KEY`. Base64 output can contain `+` and `/`, and at least one
> Claude connector header-input field has been observed silently rejecting values with those characters.
> Hex is plain `0-9a-f` — always safe to paste anywhere.

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

> Signing in shows a "Google hasn't verified this app" warning — expected in Testing mode. Click *Continue*.
>
> **Testing-status apps: refresh tokens expire after 7 days**, regardless of activity — this is a hard Google
> policy for unverified/Testing OAuth consent screens, not a bug here. Expect every connected account to need
> `remove_account` + `add_account` again about once a week. If that's too often, click **Publish App** on the
> consent screen (Google does not require verification review for the `gmail.modify`/`gmail.send`/`calendar`
> scopes this server uses — Publishing alone removes the 7-day limit; you'll still see the "unverified app"
> warning on sign-in, which is fine for personal/internal use). Separately, any refresh token — Testing or
> Published — is pruned by Google after ~6 months of the app not using it at all.

## 2. Deploy on your own domain

Any VPS with a public IP works (a small instance is plenty — Node + SQLite).

1. **DNS**: create an `A` record, e.g. `mcp.yourdomain.com` → your VPS IP.
   - If your domain's DNS is proxied through **Cloudflare**, set the new record to **DNS only** (grey cloud) first.
     Let's Encrypt's HTTP-01 challenge needs to reach your server directly; a proxied (orange cloud) record can
     make certificate issuance fail with a generic error until you switch it back to DNS-only. You can turn
     proxying back on afterwards once the certificate exists.
   - DNS propagation is usually fast but not instant — if certificate issuance fails immediately after creating
     the record, wait a few minutes and try again before assuming something else is wrong.
2. **Firewall**: allow only 80 (Let's Encrypt challenge), 443, and your SSH port.
3. **Install** Docker + Docker Compose on the VPS, clone this repo, and create `.env` from `.env.example` (set `PUBLIC_URL=https://mcp.yourdomain.com` and `MCP_DOMAIN=mcp.yourdomain.com`).
4. **Data directory permissions**: the container runs as a non-root user (uid `1000`). A bind-mounted host
   directory keeps its host ownership regardless of what the image does internally, so create it and hand it
   over *before* the first start — otherwise the app crashes on boot with `SQLITE_CANTOPEN`:

   ```bash
   mkdir -p data && chown -R 1000:1000 data
   ```
5. **Run**:

```bash
docker compose up -d --build
```

Caddy obtains and renews the Let's Encrypt certificate automatically; the Node app is reachable only through Caddy. Verify with:

```bash
curl https://mcp.yourdomain.com/healthz
```

6. **Backups**: the `./data` directory holds the SQLite file with your (encrypted) tokens. Back it up regularly to somewhere off the VPS. Without `TOKEN_ENCRYPTION_KEY` from `.env` the backup is useless to an attacker — and to you, so back up your `.env` secrets separately and safely.

### Deploying behind an existing reverse proxy (shared server)

If you already run other apps on the box (e.g. behind [nginx-proxy-manager](https://nginxproxymanager.com/)
instead of the bundled Caddy), skip the `caddy` service entirely and join your existing setup instead:

1. Remove/ignore `Caddyfile` and the `caddy` service; keep only the app's own service definition.
2. Point it at the Docker network your reverse proxy and other apps already share (`docker network ls`,
   confirm with `docker inspect <existing-app-container>`), instead of publishing any port:

   ```yaml
   services:
     multi-g-account:
       build: .
       container_name: multi-g-account
       restart: unless-stopped
       env_file: .env
       environment:
         DB_PATH: /app/data/multi-g-account.db
       volumes:
         - ./data:/app/data
       networks:
         - web   # your shared network name
       mem_limit: 256m
       memswap_limit: 512m   # = mem_limit + desired swap

   networks:
     web:
       external: true
   ```

   Do **not** publish a `ports:` mapping for the app — the reverse proxy reaches it by container name over
   the shared network. Any published port is reachable from the open internet with no TLS or rate limiting.
3. If the box uses per-app swapfiles by convention, give this app its own rather than relying on a shared one:

   ```bash
   fallocate -l 256M /swapfile-multi-g-account
   chmod 600 /swapfile-multi-g-account
   mkswap /swapfile-multi-g-account
   swapon /swapfile-multi-g-account
   echo '/swapfile-multi-g-account none swap sw 0 0' >> /etc/fstab
   ```
4. `docker compose up -d --build`, then verify from inside the network before touching the proxy:

   ```bash
   docker run --rm --network web curlimages/curl:latest -s -o /dev/null -w '%{http_code}\n' http://multi-g-account:3000/healthz
   ```
5. In nginx-proxy-manager (or your proxy's UI): **Add Proxy Host** — Domain `mcp.yourdomain.com`,
   Forward Hostname `multi-g-account`, Forward Port `3000`, scheme `http`. On the SSL tab, request a new
   Let's Encrypt certificate and enable Force SSL — only after DNS (step 1 above) actually resolves to this
   server, or the certificate request will fail.

## 3. Connect to Claude

This server authenticates with a plain API key header, not OAuth — but Claude's custom connector UI defaults
to OAuth and auto-detects it as required the moment it sees a `401` from your server. Getting past that
default is the fiddly part; the steps below avoid the dead end.

1. Claude → **Settings → Connectors → Add custom connector**.
2. Name it anything, URL: `https://mcp.yourdomain.com/mcp` → **Continue**.
3. On the next screen, under **Authentication**, Claude will have pre-selected **Sign in now** (labeled
   "Detected") — this is an OAuth flow this server doesn't implement, and connecting will fail with
   *"Couldn't register with [name]'s sign-in service"*. **Change it to "No sign-in"** — the option described
   as *"servers that use an API key instead of OAuth"*. This is the one setting that actually matters here.
4. Further down, under **Request headers**, add one header:
   - Name: `x-api-key`
   - Value: your `MCP_API_KEY` (no `Bearer` prefix — just the raw key)
   - Tick **Required**

   Avoid using `Authorization` as the header name: in the UI this has been observed as a separate,
   greyed-out/reserved field tied to the OAuth bearer token rather than a normal custom header, so a value
   typed there may not be sent. `x-api-key` is a plain custom header and works reliably.
5. **Add**, then **Connect**. It should connect immediately — no browser redirect, since there's no OAuth
   step for the *server* auth (Google's OAuth, for individual accounts, still happens in step 6 below).
6. In a chat, ask Claude to run `add_account` (e.g. "connect my Gmail with full access and calendar full").
   Claude returns a Google OAuth URL — open it in a browser, sign in with the Google account to connect,
   approve the requested access. The account is now available to every tool via its email address.

Repeat `add_account` for each additional Google account — each call returns its own single-use link; open
them one at a time and sign in with a different Google account for each.

### If it still won't connect

- **"Couldn't register with ... sign-in service"** → Authentication is still set to "Sign in now" or "Sign
  in when needed". Edit the connector (or remove and re-add it) and pick **No sign-in**.
- **Connects, but tool calls fail as unauthorized** → the header value likely wasn't saved correctly (see the
  `Authorization`-field caveat above), or the key in Claude doesn't match `MCP_API_KEY` in the server's
  `.env`. Regenerate the key with `openssl rand -hex 32`, update `.env`, restart the container
  (`docker compose up -d`), and re-enter the new value as an `x-api-key` header.
- To confirm the server itself is fine independent of Claude: `curl -X POST https://mcp.yourdomain.com/mcp
  -H 'content-type: application/json' -H 'x-api-key: <your key>' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`
  should return your tool list, not a `401`.

## Managing accounts

Account tools (`list_accounts`, `add_account`, `remove_account`) aren't run from a terminal — they're MCP tools, so you trigger them by asking Claude in chat once the connector is set up (step 3 above).

### Add a new account

Ask Claude, e.g. "connect my other Gmail with full access and calendar full". Claude calls `add_account` and returns a single-use Google OAuth URL (10-minute TTL) — open it, sign in with the Google account to add, approve the requested scopes. It shows up in `list_accounts` right after.

### Remove an account

Ask Claude to remove it, e.g. "remove someone@gmail.com from multi-g". This deletes its tokens from the server's database only. The grant still shows under the Google account's own **Third-party access** until revoked there too — `remove_account`'s result includes the direct link ([myaccount.google.com/permissions](https://myaccount.google.com/permissions)).

### Rotate an account (fix `invalid_grant`)

`invalid_grant` on a `gmail_*`/`calendar_*` call means Google rejected the stored refresh token — `list_accounts` won't catch this, since it only checks the local DB, not Google. Causes, roughly most → least likely:

- **OAuth consent screen still in Testing publishing status** — its refresh tokens expire after 7 days flat (see the note in step 1 above). This is by far the most common cause and the only one that typically hits *every* connected account at once, since they all share the same OAuth client. Fix: reconnect (below) — or click **Publish App** on the consent screen to stop it from recurring weekly.
- the Google Cloud OAuth client's `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` was regenerated in Cloud Console — old refresh tokens are only valid for the client they were issued to. Also hits all accounts at once.
- account password changed, or access revoked manually at myaccount.google.com/permissions — hits only that one account.
- refresh token unused for ~6 months and pruned by Google — rare in practice, since any tool call refreshes it.

Fix is the same regardless of cause — re-mint the refresh token:

1. Ask Claude to `remove_account` the broken account (or all of them, if they all fail at once — that pattern points at the OAuth client/Testing-mode expiry above, not one account's own credentials).
2. Ask Claude to `add_account` again with the same scopes as before (check `list_accounts` output before removing if unsure what was granted).
3. Open the returned URL, sign in as that account, approve.

Rotating the API key (`MCP_API_KEY`, the connector's `x-api-key` header) is unrelated and doesn't need any of this — that key only guards the `/mcp` endpoint itself and is never sent to or checked by Google. See "Connects, but tool calls fail as unauthorized" above for that one.

## Security model

- **Server auth**: every `/mcp` request must carry the API key; comparison is constant-time. `/oauth/callback` is protected by single-use, 10-minute-TTL `state` values instead.
- **Token storage**: Google refresh/access tokens are encrypted with AES-256-GCM before touching disk; the key lives only in the environment. Tampered ciphertexts fail authentication and are rejected.
- **Scopes**: requested per account and per service, at the level you choose (`readonly` vs `full`); tools verify granted scopes before every call and fail with a clear message instead of escalating.
- **Transport**: HTTPS-only via your reverse proxy (Caddy, or nginx-proxy-manager on a shared server); the app container has no published ports.
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

[MIT](LICENSE)
