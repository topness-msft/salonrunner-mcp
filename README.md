# salonrunner-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an AI assistant **find, book, and
cancel salon appointments** through your personal SalonRunner / Rosy Salon Software client
account — the same booking site many salons use.

It's **self-hosted**: you run your own instance with your own login. Your credentials never
touch anyone else's server. Works both as a local tool (Claude Desktop, Cursor, Copilot CLI)
and as a remote connector for **claude.ai**.

> ⚠️ Unofficial, uses undocumented endpoints, personal use only. Read [DISCLAIMER.md](./DISCLAIMER.md).

## Tools

| Tool | What it does |
|------|--------------|
| `list_services` | List bookable services (name, id, price) |
| `list_providers` | List stylists; optionally only those who do a given service |
| `find_availability` | Open slots for a service over a date range (optionally one provider) |
| `list_my_appointments` | Your upcoming appointments |
| `book_appointment` | Book a slot returned by `find_availability` |
| `cancel_appointment` | Cancel by appointment id |

## How it works

```
list/find/book/cancel
        │
   this server ──login──► app.salonrunner.com  (session cookie)
        │      ──authv2─► customer JWT (30 min, auto-refreshed)
        │      ──reads──► app.rosysalonsoftware.com/api/v2  (Bearer JWT)
        └──────writes───► /customer/appointments/{book,cancel}.json  (cookie)
```

`customerId` and `corporateId` are read from the JWT automatically. Availability is computed
from the provider's per-service duration and the salon's slot grid (`SALONRUNNER_SLOT_MINUTES`,
default 15).

## Configuration

There are two ways to run it, and they get their salon credentials differently:

- **Local (stdio):** credentials come from the environment (`.env`).
- **Remote (HTTP, claude.ai):** credentials are entered on the connector's **login screen** and
  encrypted into the token — the server needs **no** salon credentials in its environment.

| Variable | Used by | Notes |
|----------|---------|-------|
| `SALONRUNNER_SALON_ID` | stdio | The `id` in your booking URL `…/customer/login.htm?id=XXXXX` |
| `SALONRUNNER_USERNAME` / `SALONRUNNER_PASSWORD` | stdio | Your client login |
| `SALONRUNNER_CUSTOMER_ID` | both | Auto-discovered; set only if discovery fails |
| `SALONRUNNER_SLOT_MINUTES` | both | Salon booking granularity (default 15) |
| `SALONRUNNER_READ_ONLY` | both | `true` disables book/cancel while you try it out |
| `SESSION_SIGNING_KEY` | HTTP | Signs tokens + encrypts the credentials inside them; survives restarts/scale-to-zero (>=16 chars) |
| `PUBLIC_URL` | HTTP | This server's public URL, e.g. `https://your-app.fly.dev` |

In HTTP mode the salon id + username + password are collected on the login screen (validated by a
real SalonRunner login) and encrypted into the OAuth token, so **one deployment can serve multiple
salons** and there are no salon secrets on the server.

## Option A — Local (Claude Desktop / Cursor / Copilot CLI)

```bash
npm install && npm run build
```

Add to your client's MCP config (Claude Desktop: `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "salonrunner": {
      "command": "node",
      "args": ["/absolute/path/to/salonrunner-mcp/dist/stdio.js"],
      "env": {
        "SALONRUNNER_SALON_ID": "21248",
        "SALONRUNNER_USERNAME": "you@example.com",
        "SALONRUNNER_PASSWORD": "your-password"
      }
    }
  }
}
```

No hosting, no OAuth — credentials stay on your machine. Recommended if you don't need claude.ai.

## Option B — Remote (claude.ai custom connector)

claude.ai can only use **remote** MCP servers, so you deploy your own instance.

### Deploy to Fly.io

```bash
fly launch --no-deploy          # pick a unique app name; creates the app
fly secrets set \
  SESSION_SIGNING_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))") \
  PUBLIC_URL=https://YOUR-APP.fly.dev
fly deploy
fly scale count 1               # in-memory MCP sessions: keep a single instance
```

No salon credentials are configured here — users supply them on the login screen. The server
**refuses to start** without `SESSION_SIGNING_KEY`. Credentials are validated by a real
SalonRunner login and then encrypted into the (signed) token, which claude.ai stores, so the app
**scales to zero** between uses and you **authorize only once** — cold starts (~3s) are
transparent and never re-prompt.

### Connect in claude.ai

1. **Settings → Connectors → Add custom connector**.
2. URL: `https://YOUR-APP.fly.dev/mcp`
3. Claude opens the connector's login screen → enter your **salon id + username + password**.
4. The six tools appear in chat.

### Run the remote server locally (testing)

```bash
SESSION_SIGNING_KEY=local-dev-please-change PUBLIC_URL=http://localhost:8787 npm run start:http
```

## Security model

Two independent auth layers:

1. **claude.ai ↔ this server** — OAuth 2.1 (PKCE + dynamic client registration). The login
   screen authenticates the user with a **real SalonRunner login**; the credentials are then
   **AES-GCM encrypted and embedded inside the HMAC-signed token** (keyed by `SESSION_SIGNING_KEY`).
   No server-side session store, so authorization survives restarts and scale-to-zero.
2. **this server ↔ SalonRunner** — login → session cookie → short-lived JWT, auto-refreshed,
   using the credentials decrypted from the caller's token.

The server holds **no salon credentials at rest** — they live (encrypted) inside each user's
token and are only decrypted in memory per request. One deployment can serve multiple salons.
A leaked token can't be revoked individually; rotate `SESSION_SIGNING_KEY` to invalidate **all**
tokens (everyone re-enters credentials once). Keep `SESSION_SIGNING_KEY` secret and serve only
over HTTPS.

## Notes & limitations

- Built on **undocumented** customer endpoints; they can change without notice. Base URLs are
  configurable so you can adapt quickly.
- Real bookings/cancellations incur the salon's **cancellation-policy fees**. Tools surface the
  service/provider/time before acting; consider running with `SALONRUNNER_READ_ONLY=true` first.
- `SALONRUNNER_SLOT_MINUTES` must match your salon's scheduling grid (default 15) for accurate
  availability.
- The officially documented, partner-only **Rosy Salon Software API** (`api.salonrunner.com`)
  is a separate product requiring a salon-issued ApiKey; this project does not use it.

## License

MIT — see [LICENSE](./LICENSE). No warranty.
