import express, { type Request, type Response, type RequestHandler, Router } from "express";
import crypto from "node:crypto";
import type { Credentials } from "../config.js";

/**
 * Stateless, multi-user OAuth 2.1 provider for self-hosted MCP servers
 * (claude.ai custom connectors).
 *
 * The authorize screen collects the user's SalonRunner salon id + username +
 * password and validates them with a live SalonRunner login. On success the
 * credentials are AES-GCM encrypted and embedded inside the (HMAC-signed) tokens,
 * which claude.ai stores. The server therefore holds NO per-user state — issued
 * tokens carry everything needed — so authorization survives restarts and
 * scale-to-zero, and one deployment can serve many salons.
 *
 *   POST /register                               (RFC 7591) -> signed client_id
 *   GET  /.well-known/oauth-authorization-server (RFC 8414)
 *   GET  /.well-known/oauth-protected-resource   (RFC 9728)
 *   GET/POST /authorize                          (PKCE S256, credential login)
 *   POST /token                                  (code + refresh)
 *
 * The only durable server config is SESSION_SIGNING_KEY (signs tokens + derives
 * the credential-encryption key).
 */

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

interface Signed {
  t: "client" | "code" | "access" | "refresh";
  exp?: number;
  [k: string]: unknown;
}

/** Requests that passed `requireBearer` carry the decrypted SalonRunner credentials. */
export interface AuthedRequest extends Request {
  salonCreds?: Credentials;
}

export type ValidateCredentials = (creds: Credentials) => Promise<boolean>;

function makeCrypto(signingKey: string) {
  const encKey = crypto.createHash("sha256").update(`${signingKey}:enc`).digest(); // 32 bytes
  const hmac = (body: string) => crypto.createHmac("sha256", signingKey).update(body).digest("base64url");

  const sign = (payload: Signed): string => {
    const body = b64url(JSON.stringify(payload));
    return `${body}.${hmac(body)}`;
  };
  const verify = (token: string | undefined, type: Signed["t"]): Signed | null => {
    if (!token) return null;
    const dot = token.lastIndexOf(".");
    if (dot < 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = hmac(body);
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

  const encryptCreds = (creds: Credentials): string => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encKey, iv);
    const pt = JSON.stringify({ s: creds.salonId, u: creds.username, p: creds.password });
    const ct = Buffer.concat([cipher.update(pt, "utf8"), cipher.final()]);
    return b64url(Buffer.concat([iv, cipher.getAuthTag(), ct]));
  };
  const decryptCreds = (blob: unknown): Credentials | null => {
    if (typeof blob !== "string") return null;
    try {
      const buf = Buffer.from(blob, "base64url");
      const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
      const d = crypto.createDecipheriv("aes-256-gcm", encKey, iv);
      d.setAuthTag(tag);
      const pt = JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
      return { salonId: pt.s, username: pt.u, password: pt.p };
    } catch {
      return null;
    }
  };

  return { sign, verify, encryptCreds, decryptCreds };
}

export function buildOAuth(publicUrl: string, signingKey: string, validate: ValidateCredentials) {
  const issuer = publicUrl.replace(/\/$/, "");
  const { sign, verify, encryptCreds, decryptCreds } = makeCrypto(signingKey);

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
    res.status(201).json({
      client_id: sign({ t: "client", redirect_uris: redirectUris, iat: Date.now() }),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    });
  });

  const clientRedirects = (clientId: string): string[] | null => {
    const c = verify(clientId, "client");
    return c ? (c.redirect_uris as string[]) : null;
  };

  // --- authorization endpoint (credential login) ---
  function renderLogin(res: Response, params: Record<string, string>, fields: Record<string, string>, error?: string) {
    const hidden = Object.entries(params)
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}"/>`)
      .join("");
    const inp = (name: string, ph: string, type = "text", val = "") =>
      `<input ${type === "password" ? "type=password" : ""} name="${name}" placeholder="${ph}" value="${escapeHtml(val)}" ${type === "number" ? "inputmode=numeric" : ""}
        style="width:100%;padding:.6rem;margin:.4rem 0;font-size:1rem;box-sizing:border-box"/>`;
    res.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:system-ui;max-width:23rem;margin:3rem auto;padding:0 1rem">
<h2>SalonRunner MCP</h2>
<p>Sign in with your SalonRunner account to connect.</p>
${error ? `<p style="color:#c00">${escapeHtml(error)}</p>` : ""}
<form method="POST" action="/authorize">${hidden}
  ${inp("salonId", "Salon id (from your booking URL)", "number", fields.salonId ?? "")}
  ${inp("username", "Username or email", "text", fields.username ?? "")}
  ${inp("password", "Password", "password")}
  <button style="width:100%;padding:.6rem;margin-top:.4rem;font-size:1rem">Authorize</button>
</form>
<p style="color:#888;font-size:.8rem">Your salon id is the number in <code>…/customer/login.htm?id=<b>XXXXX</b></code>.</p>
</body>`);
  }

  router.get("/authorize", (req, res) => {
    const q = req.query as Record<string, string>;
    if (q.response_type !== "code" || !q.client_id || !q.redirect_uri || q.code_challenge_method !== "S256") {
      return res.status(400).send("invalid_request");
    }
    const redirects = clientRedirects(q.client_id);
    if (!redirects || !redirects.includes(q.redirect_uri)) return res.status(400).send("invalid_client");
    renderLogin(res, { client_id: q.client_id, redirect_uri: q.redirect_uri, state: q.state ?? "", code_challenge: q.code_challenge }, {});
  });

  router.post("/authorize", async (req, res) => {
    const { client_id, redirect_uri, state, code_challenge, salonId, username, password } = req.body ?? {};
    const oauth = { client_id, redirect_uri, state: state ?? "", code_challenge };
    const redirects = clientRedirects(client_id);
    if (!redirects || !redirects.includes(redirect_uri)) return res.status(400).send("invalid_client");

    const sid = parseInt(salonId, 10);
    if (!sid || !username || !password) {
      return renderLogin(res, oauth, { salonId, username }, "Please enter your salon id, username and password.");
    }
    const creds: Credentials = { salonId: sid, username, password };
    let ok = false;
    try {
      ok = await validate(creds);
    } catch {
      ok = false;
    }
    if (!ok) {
      return renderLogin(res, oauth, { salonId, username }, "Could not sign in — check your salon id, username and password.");
    }

    const code = sign({ t: "code", redirect_uri, cc: code_challenge, enc: encryptCreds(creds), exp: Date.now() + 60_000 });
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
      return res.json(issueTokens(payload.enc as string));
    }
    if (grant_type === "refresh_token") {
      const payload = verify(req.body?.refresh_token, "refresh");
      if (!payload) return res.status(400).json({ error: "invalid_grant" });
      return res.json(issueTokens(payload.enc as string));
    }
    res.status(400).json({ error: "unsupported_grant_type" });
  });

  function issueTokens(enc: string) {
    const ttl = 3600;
    return {
      access_token: sign({ t: "access", enc, exp: Date.now() + ttl * 1000 }),
      token_type: "Bearer",
      expires_in: ttl,
      refresh_token: sign({ t: "refresh", enc, exp: Date.now() + 30 * 86_400_000 }),
    };
  }

  // --- bearer middleware: validate token, decrypt creds onto the request ---
  const requireBearer: RequestHandler = (req, res, next) => {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const payload = verify(token, "access");
    const creds = payload ? decryptCreds(payload.enc) : null;
    if (!creds) {
      res
        .status(401)
        .set("WWW-Authenticate", `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`)
        .json({ error: "invalid_token" });
      return;
    }
    (req as AuthedRequest).salonCreds = creds;
    next();
  };

  return { router, requireBearer };
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
