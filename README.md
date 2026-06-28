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

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Notes |
|----------|----------|-------|
| `SALONRUNNER_SALON_ID` | ✅ | The `id` in your booking URL `…/customer/login.htm?id=XXXXX` |
| `SALONRUNNER_USERNAME` / `SALONRUNNER_PASSWORD` | ✅ | Your client login |
| `SALONRUNNER_CUSTOMER_ID` | — | Auto-discovered; set only if discovery fails |
| `SALONRUNNER_SLOT_MINUTES` | — | Salon booking granularity (default 15) |
| `SALONRUNNER_READ_ONLY` | — | `true` disables book/cancel while you try it out |
| `MCP_AUTH_PASSWORD` | HTTP only | Password claude.ai will prompt for; **server won't start without it** |
| `PUBLIC_URL` | HTTP only | This server's public URL, e.g. `https://your-app.fly.dev` |

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
  SALONRUNNER_SALON_ID=21248 \
  SALONRUNNER_USERNAME=you@example.com \
  SALONRUNNER_PASSWORD=your-password \
  MCP_AUTH_PASSWORD=choose-a-connector-password \
  PUBLIC_URL=https://YOUR-APP.fly.dev
fly deploy
```

The server **refuses to start** without `MCP_AUTH_PASSWORD`, so you can't accidentally expose
an open booking endpoint. It scales to zero between uses (`fly.toml`).

### Connect in claude.ai

1. **Settings → Connectors → Add custom connector**.
2. URL: `https://YOUR-APP.fly.dev/mcp`
3. Claude runs an OAuth flow → enter your `MCP_AUTH_PASSWORD` on the consent screen.
4. The six tools appear in chat.

### Run the remote server locally (testing)

```bash
MCP_AUTH_PASSWORD=test PUBLIC_URL=http://localhost:8787 npm run start:http
```

## Security model

Two independent auth layers:

1. **claude.ai ↔ this server** — OAuth 2.1 (PKCE + dynamic client registration), single user,
   gated by `MCP_AUTH_PASSWORD`. (Local stdio mode needs none.)
2. **this server ↔ SalonRunner** — your login → session cookie → short-lived JWT, auto-refreshed.

Because each user deploys their own instance, the server is single-tenant: it only ever holds
**your** credentials. Keep your deployment private and your `MCP_AUTH_PASSWORD` strong.

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
