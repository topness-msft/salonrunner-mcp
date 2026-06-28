#!/usr/bin/env node
import express from "express";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "./server.js";
import { SalonRunnerClient } from "./salonrunner/client.js";
import { configFor, type Credentials } from "./config.js";
import { buildOAuth, type AuthedRequest, type ValidateCredentials } from "./auth/oauth.js";

/**
 * Remote / Streamable HTTP entrypoint — for claude.ai custom connectors.
 *
 * Multi-user: each user authenticates with their own SalonRunner credentials on
 * the connector's authorize screen; those credentials are encrypted inside the
 * issued token. There is no per-user server config — only SESSION_SIGNING_KEY.
 */
async function main() {
  const port = parseInt(process.env.PORT ?? "8787", 10);
  const publicUrl = process.env.PUBLIC_URL ?? `http://localhost:${port}`;
  const signingKey = process.env.SESSION_SIGNING_KEY;
  if (!signingKey || signingKey.length < 16) {
    console.error(
      "Refusing to start HTTP mode without a strong SESSION_SIGNING_KEY (>=16 chars). " +
        "Generate one with:  node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\""
    );
    process.exit(1);
  }

  // One SalonRunner client per distinct credential set, reused while the machine is warm.
  const clients = new Map<string, SalonRunnerClient>();
  const credKey = (c: Credentials) =>
    crypto.createHash("sha256").update(`${c.salonId}:${c.username}:${c.password}`).digest("hex");
  const clientFor = (c: Credentials): SalonRunnerClient => {
    const k = credKey(c);
    let cl = clients.get(k);
    if (!cl) {
      cl = new SalonRunnerClient(configFor(c));
      clients.set(k, cl);
    }
    return cl;
  };

  // Validate credentials by performing a real SalonRunner login.
  const validate: ValidateCredentials = async (creds) => {
    try {
      await new SalonRunnerClient(configFor(creds)).customerId();
      return true;
    } catch {
      return false;
    }
  };

  const app = express();
  const { router, requireBearer } = buildOAuth(publicUrl, signingKey, validate);
  app.use(router);
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post("/mcp", requireBearer, express.json(), async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? transports[sessionId] : undefined;

    if (!transport && isInitializeRequest(req.body)) {
      const creds = (req as AuthedRequest).salonCreds!;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport!;
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) delete transports[transport!.sessionId];
      };
      await createServer(clientFor(creds)).connect(transport);
    } else if (!transport) {
      return res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "No valid session; send an initialize request first." },
        id: null,
      });
    }

    await transport.handleRequest(req, res, req.body);
  });

  const bySession: express.RequestHandler = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? transports[sessionId] : undefined;
    if (!transport) {
      res.status(400).send("Unknown session");
      return;
    }
    await transport.handleRequest(req, res);
  };
  app.get("/mcp", requireBearer, bySession);
  app.delete("/mcp", requireBearer, bySession);

  app.listen(port, () => console.error(`salonrunner-mcp HTTP listening on ${publicUrl} (port ${port})`));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
