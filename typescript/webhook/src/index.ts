/**
 * Webhook service entry point.
 * Configures server, middleware, static files, and routes.
 */

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

import { getSettings } from "./config.js";
import { webhookHandler, taskStatusHandler, eventsHandler } from "./handlers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const fastify = Fastify({
  logger: true,
});

// Serve static files for the tester UI
// Production: copied to ./static during build (from frontend/dist)
// Local dev: use frontend/dist after running `npm run build` in frontend/
let staticDir = path.join(__dirname, "..", "static");
if (!fs.existsSync(staticDir)) {
  staticDir = path.join(__dirname, "..", "..", "..", "frontend", "dist");
}

// Serve Vite's assets directory
const assetsDir = path.join(staticDir, "assets");
if (fs.existsSync(assetsDir)) {
  fastify.register(fastifyStatic, {
    root: assetsDir,
    prefix: "/assets/",
    decorateReply: false,
  });
}

// Demo mode: rate limit POST /webhook to 10 req/min per IP
const settings = getSettings();
if (settings.demoMode) {
  const requestLog = new Map<string, number[]>();
  const MAX_REQUESTS = 10;
  const WINDOW_MS = 60_000;

  fastify.addHook("onRequest", async (request, reply) => {
    if (request.method !== "POST" || request.url !== "/webhook") return;

    const clientIp = request.ip;
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    const timestamps = (requestLog.get(clientIp) ?? []).filter((t) => t > cutoff);

    if (timestamps.length >= MAX_REQUESTS) {
      reply.status(429).send({ detail: "Rate limit exceeded. Try again later." });
      return;
    }

    timestamps.push(now);
    requestLog.set(clientIp, timestamps);
  });

  console.log("Demo mode enabled - rate limiting active on /webhook");
}

// Content type parser to get raw body for signature verification
fastify.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  (_req, body, done) => {
    done(null, body);
  }
);

// Routes
fastify.get("/health", async () => {
  return { status: "healthy" };
});

fastify.get("/", async (_request, reply) => {
  const indexPath = path.join(staticDir, "index.html");
  if (fs.existsSync(indexPath)) {
    return reply.type("text/html").send(fs.readFileSync(indexPath, "utf-8"));
  }
  return {
    message:
      "Webhook service running. POST to /webhook to trigger workflows. Build frontend with: cd frontend && npm run build",
  };
});

fastify.get("/events", eventsHandler);

fastify.post(
  "/webhook",
  { config: { rawBody: true } },
  webhookHandler
);

fastify.get<{ Params: { taskRunId: string } }>(
  "/task-status/:taskRunId",
  taskStatusHandler
);

// Start server
async function start() {
  const settings = getSettings();

  // Log configuration status on startup
  if (settings.renderUseLocalDev) {
    console.log(
      `Local dev mode enabled - using task server at ${settings.renderLocalDevUrl}`
    );
  }

  if (!settings.renderApiKey) {
    console.warn(
      "RENDER_API_KEY not set - workflow triggering will fail. " +
        "Set this environment variable to enable workflow integration."
    );
  }

  if (!settings.renderUseLocalDev && !settings.workflowSlug) {
    console.warn(
      "WORKFLOW_SLUG not set - workflow triggering will fail in production. " +
        "Set this to your Workflow service name on Render."
    );
  }

  try {
    await fastify.listen({ host: settings.host, port: settings.port });
    console.log(`Webhook service started on http://${settings.host}:${settings.port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
