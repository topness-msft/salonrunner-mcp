import express, { type Request, type Response, type RequestHandler, Router } from "express";
import crypto from "node:crypto";

/**
 * Minimal single-user OAuth 2.1 provider so a *self-hosted* server can be added
 * to claude.ai as a custom connector without exposing an open booking endpoint.
 *
 * - Dynamic Client Registration (RFC 7591)        POST /register
 * - Authorization Server Metadata (RFC 8414)      GET  /.well-known/oauth-authorization-server
 * - Protected Resource Metadata (RFC 9728)        GET  /.well-known/oauth-protected-resource
 * - Authorization endpoint (PKCE S256)            GET  /authorize  POST /authorize
 * - Token endpoint (code + refresh)               POST /token
 *
 * "Single user" = anyone who knows MCP_AUTH_PASSWORD (the deployer). This is the
 * gate between claude.ai and *your* instance; your SalonRunner creds live in env.
 */

interface Client {
  client_id: string;
  redirect_uris: string[];
}
interface PendingCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expires: number;
}

const b64url = (b: Buffer) => b.toString("base64url");
const randomId = () => b64url(crypto.randomBytes(24));

export function buildOAuth(publicUrl: string, password: string) {
  const issuer = publicUrl.replace(/\/$/, "");
  const clients = new Map<string, Client>();
  const codes = new Map<string, PendingCode>();
  const accessTokens = new Map<string, number>(); // token -> expiry ms
  const refreshTokens = new Set<string>();

  const router = Router();
  router.use(express.urlencoded({ extended: true }));
  router.use(express.json());

  // --- discovery metadata ---
  const resourceMeta = {
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
  };
  router.get("/.well-known/oauth-protected-resource", (_req, res) => res.json(resourceMeta));
  router.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => res.json(resourceMeta));

  router.get("/.well-known/oauth-authorization-server", (_req, res) =>
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    })
  );

  // --- dynamic client registration ---
  router.post("/register", (req, res) => {
    const redirectUris: string[] = req.body?.redirect_uris ?? [];
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      return res.status(400).json({ error: "invalid_redirect_uri" });
    }
    const client: Client = { client_id: randomId(), redirect_uris: redirectUris };
    clients.set(client.client_id, client);
    res.status(201).json({
      client_id: client.client_id,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    });
  });

  // --- authorization endpoint ---
  function renderLogin(res: Response, params: Record<string, string>, error?: string) {
    const hidden = Object.entries(params)
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}"/>`)
      .join("");
    res.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:system-ui;max-width:22rem;margin:4rem auto;padding:0 1rem">
<h2>SalonRunner MCP</h2>
<p>Authorize this connector to your salon account.</p>
${error ? `<p style="color:#c00">${escapeHtml(error)}</p>` : ""}
<form method="POST" action="/authorize">${hidden}
  <input type="password" name="password" placeholder="Connector password" autofocus
    style="width:100%;padding:.6rem;margin:.5rem 0;font-size:1rem"/>
  <button style="width:100%;padding:.6rem;font-size:1rem">Authorize</button>
</form></body>`);
  }

  router.get("/authorize", (req, res) => {
    const q = req.query as Record<string, string>;
    if (q.response_type !== "code" || !q.client_id || !q.redirect_uri || q.code_challenge_method !== "S256") {
      return res.status(400).send("invalid_request");
    }
    const client = clients.get(q.client_id);
    if (!client || !client.redirect_uris.includes(q.redirect_uri)) return res.status(400).send("invalid_client");
    renderLogin(res, {
      client_id: q.client_id,
      redirect_uri: q.redirect_uri,
      state: q.state ?? "",
      code_challenge: q.code_challenge,
    });
  });

  router.post("/authorize", (req, res) => {
    const { client_id, redirect_uri, state, code_challenge, password: pw } = req.body ?? {};
    const client = clients.get(client_id);
    if (!client || !client.redirect_uris.includes(redirect_uri)) return res.status(400).send("invalid_client");
    if (pw !== password) {
      return renderLogin(res, { client_id, redirect_uri, state: state ?? "", code_challenge }, "Incorrect password.");
    }
    const code = randomId();
    codes.set(code, { clientId: client_id, redirectUri: redirect_uri, codeChallenge: code_challenge, expires: Date.now() + 60_000 });
    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    res.redirect(url.toString());
  });

  // --- token endpoint ---
  router.post("/token", (req, res) => {
    const { grant_type } = req.body ?? {};
    if (grant_type === "authorization_code") {
      const { code, code_verifier, redirect_uri } = req.body;
      const pending = codes.get(code);
      codes.delete(code);
      if (!pending || pending.expires < Date.now() || pending.redirectUri !== redirect_uri) {
        return res.status(400).json({ error: "invalid_grant" });
      }
      const challenge = b64url(crypto.createHash("sha256").update(code_verifier ?? "").digest());
      if (challenge !== pending.codeChallenge) return res.status(400).json({ error: "invalid_grant" });
      return res.json(issueTokens());
    }
    if (grant_type === "refresh_token") {
      const { refresh_token } = req.body;
      if (!refreshTokens.has(refresh_token)) return res.status(400).json({ error: "invalid_grant" });
      refreshTokens.delete(refresh_token);
      return res.json(issueTokens());
    }
    res.status(400).json({ error: "unsupported_grant_type" });
  });

  function issueTokens() {
    const access = randomId();
    const refresh = randomId();
    const ttl = 3600;
    accessTokens.set(access, Date.now() + ttl * 1000);
    refreshTokens.add(refresh);
    return { access_token: access, token_type: "Bearer", expires_in: ttl, refresh_token: refresh };
  }

  // --- bearer middleware protecting /mcp ---
  const requireBearer: RequestHandler = (req, res, next) => {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const exp = accessTokens.get(token);
    if (!token || !exp || exp < Date.now()) {
      res
        .status(401)
        .set("WWW-Authenticate", `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`)
        .json({ error: "invalid_token" });
      return;
    }
    next();
  };

  return { router, requireBearer };
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
