#!/usr/bin/env node
import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer, createClient } from "./server.js";
import { buildOAuth } from "./auth/oauth.js";

/**
 * Remote / Streamable HTTP entrypoint — for claude.ai custom connectors.
 * Requires MCP_AUTH_PASSWORD (the gate between claude.ai and this instance).
 */
async function main() {
  const port = parseInt(process.env.PORT ?? "8787", 10);
  const publicUrl = process.env.PUBLIC_URL ?? `http://localhost:${port}`;
  const password = process.env.MCP_AUTH_PASSWORD;
  if (!password) {
    console.error(
      "Refusing to start HTTP mode without MCP_AUTH_PASSWORD set — that would expose an open booking endpoint."
    );
    process.exit(1);
  }

  const app = express();
  const client = createClient(); // single shared SalonRunner session (cached JWT)
  const { router, requireBearer } = buildOAuth(publicUrl, password);
  app.use(router);
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  // Stateful MCP sessions keyed by the mcp-session-id header.
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post("/mcp", requireBearer, express.json(), async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? transports[sessionId] : undefined;

    if (!transport && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport!;
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) delete transports[transport!.sessionId];
      };
      await createServer(client).connect(transport);
    } else if (!transport) {
      return res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "No valid session; send an initialize request first." },
        id: null,
      });
    }

    await transport.handleRequest(req, res, req.body);
  });

  // SSE stream + session teardown reuse the same transport.
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
