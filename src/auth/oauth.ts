import express, { type Response, type RequestHandler, Router } from "express";
import crypto from "node:crypto";

/**
 * Stateless single-user OAuth 2.1 provider for self-hosted MCP servers
 * (claude.ai custom connectors).
 *
 * Everything is HMAC-signed with SESSION_SIGNING_KEY rather than stored in memory,
 * so issued client_ids, authorization codes and tokens remain valid across machine
 * restarts and scale-to-zero — no re-authorization after a cold start, and no
 * server-side session store.
 *
 *   POST /register                              (RFC 7591) -> signed client_id
 *   GET  /.well-known/oauth-authorization-server (RFC 8414)
 *   GET  /.well-known/oauth-protected-resource   (RFC 9728)
 *   GET/POST /authorize                          (PKCE S256, password gate)
 *   POST /token                                  (code + refresh)
 *
 * "Single user" = anyone who knows MCP_AUTH_PASSWORD (the deployer). SalonRunner
 * credentials live in env/secrets, not here.
 */

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

interface Signed {
  t: "client" | "code" | "access" | "refresh";
  exp?: number;
  [k: string]: unknown;
}

function makeSigner(key: string) {
  const mac = (body: string) => crypto.createHmac("sha256", key).update(body).digest("base64url");
  const sign = (payload: Signed): string => {
    const body = b64url(JSON.stringify(payload));
    return `${body}.${mac(body)}`;
  };
  const verify = (token: string | undefined, type: Signed["t"]): Signed | null => {
    if (!token) return null;
    const dot = token.lastIndexOf(".");
    if (dot < 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = mac(body);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    let payload: Signed;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString());
    } catch {
      return null;
    }
    if (payload.t !== type) return null;
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  };
  return { sign, verify };
}

export function buildOAuth(publicUrl: string, password: string, signingKey: string) {
  const issuer = publicUrl.replace(/\/$/, "");
  const { sign, verify } = makeSigner(signingKey);

  const router = Router();
  router.use(express.urlencoded({ extended: true }));
  router.use(express.json());

  // --- discovery metadata ---
  const resourceMeta = { resource: `${issuer}/mcp`, authorization_servers: [issuer] };
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

  // --- dynamic client registration (stateless: client_id encodes redirect_uris) ---
  router.post("/register", (req, res) => {
    const redirectUris: string[] = req.body?.redirect_uris ?? [];
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      return res.status(400).json({ error: "invalid_redirect_uri" });
    }
    const client_id = sign({ t: "client", redirect_uris: redirectUris, iat: Date.now() });
    res.status(201).json({
      client_id,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    });
  });

  function clientRedirects(clientId: string): string[] | null {
    const c = verify(clientId, "client");
    return c ? (c.redirect_uris as string[]) : null;
  }

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
    const redirects = clientRedirects(q.client_id);
    if (!redirects || !redirects.includes(q.redirect_uri)) return res.status(400).send("invalid_client");
    renderLogin(res, {
      client_id: q.client_id,
      redirect_uri: q.redirect_uri,
      state: q.state ?? "",
      code_challenge: q.code_challenge,
    });
  });

  router.post("/authorize", (req, res) => {
    const { client_id, redirect_uri, state, code_challenge, password: pw } = req.body ?? {};
    const redirects = clientRedirects(client_id);
    if (!redirects || !redirects.includes(redirect_uri)) return res.status(400).send("invalid_client");
    if (pw !== password) {
      return renderLogin(res, { client_id, redirect_uri, state: state ?? "", code_challenge }, "Incorrect password.");
    }
    const code = sign({ t: "code", redirect_uri, cc: code_challenge, exp: Date.now() + 60_000 });
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
      const payload = verify(code, "code");
      if (!payload || payload.redirect_uri !== redirect_uri) return res.status(400).json({ error: "invalid_grant" });
      const challenge = b64url(crypto.createHash("sha256").update(code_verifier ?? "").digest());
      if (challenge !== payload.cc) return res.status(400).json({ error: "invalid_grant" });
      return res.json(issueTokens());
    }
    if (grant_type === "refresh_token") {
      const payload = verify(req.body?.refresh_token, "refresh");
      if (!payload) return res.status(400).json({ error: "invalid_grant" });
      return res.json(issueTokens());
    }
    res.status(400).json({ error: "unsupported_grant_type" });
  });

  function issueTokens() {
    const ttl = 3600;
    return {
      access_token: sign({ t: "access", sub: "user", exp: Date.now() + ttl * 1000 }),
      token_type: "Bearer",
      expires_in: ttl,
      refresh_token: sign({ t: "refresh", sub: "user", exp: Date.now() + 30 * 86_400_000 }),
    };
  }

  // --- bearer middleware protecting /mcp ---
  const requireBearer: RequestHandler = (req, res, next) => {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!verify(token, "access")) {
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
