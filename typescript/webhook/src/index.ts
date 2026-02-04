/**
 * Fastify webhook service that validates signatures and triggers Render Workflows.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";

import { getSettings } from "./config.js";
import { WebhookEventSchema, type WebhookEvent, type WebhookResponse } from "./types.js";
import {
  verifySignature,
  SignatureVerificationError,
  TimestampValidationError,
} from "./security.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// SSE clients for real-time updates
const sseClients: Set<FastifyReply> = new Set();

// Render SDK - optional for local development
let Render: typeof import("@renderinc/sdk").Render | null = null;
let RENDER_SDK_AVAILABLE = false;

try {
  const sdk = await import("@renderinc/sdk");
  Render = sdk.Render;
  RENDER_SDK_AVAILABLE = true;
} catch {
  console.warn("@renderinc/sdk not available - workflow triggering disabled");
}

const fastify = Fastify({
  logger: true,
});

// Serve static files for the tester UI
// Production: copied to ./static during build (from frontend/dist)
// Local dev: use frontend/dist after running `npm run build` in frontend/
import fs from "node:fs";
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

/**
 * Broadcast an event to all connected SSE clients.
 */
function broadcastEvent(eventType: string, data: object): void {
  const message = JSON.stringify({ type: eventType, data });
  for (const client of sseClients) {
    client.raw.write(`event: webhook\ndata: ${message}\n\n`);
  }
}

// Health check
fastify.get("/health", async () => {
  return { status: "healthy" };
});

// Serve the webhook tester UI
fastify.get("/", async (request, reply) => {
  const indexPath = path.join(staticDir, "index.html");
  if (fs.existsSync(indexPath)) {
    return reply.type("text/html").send(fs.readFileSync(indexPath, "utf-8"));
  }
  return {
    message:
      "Webhook service running. POST to /webhook to trigger workflows. Build frontend with: cd frontend && npm run build",
  };
});

// SSE endpoint for real-time updates
fastify.get("/events", async (request, reply) => {
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("Access-Control-Allow-Origin", "*");

  sseClients.add(reply);

  // Keep connection alive with periodic pings
  const pingInterval = setInterval(() => {
    reply.raw.write("event: ping\ndata: \n\n");
  }, 30000);

  // Cleanup on disconnect
  request.raw.on("close", () => {
    clearInterval(pingInterval);
    sseClients.delete(reply);
  });

  // Don't end the response - keep it open for SSE
  return reply;
});

// Webhook endpoint
fastify.post(
  "/webhook",
  {
    config: {
      rawBody: true,
    },
  },
  async (
    request: FastifyRequest<{
      Headers: {
        "x-webhook-signature": string;
        "x-webhook-timestamp": string;
      };
    }>,
    reply
  ) => {
    const settings = getSettings();

    // Get raw body for signature verification
    const rawBody = Buffer.from(request.body as string);
    const signatureHeader = request.headers["x-webhook-signature"];
    const timestamp = request.headers["x-webhook-timestamp"];

    // Verify signature and timestamp
    try {
      verifySignature(
        rawBody,
        signatureHeader,
        timestamp,
        settings.webhookSecret,
        settings.timestampToleranceSeconds
      );
    } catch (error) {
      if (error instanceof TimestampValidationError) {
        fastify.log.warn(`Timestamp validation failed: ${error.message}`);
        return reply.status(401).send({
          detail: `Timestamp validation failed: ${error.message}`,
        });
      }
      if (error instanceof SignatureVerificationError) {
        fastify.log.warn(`Signature verification failed: ${error.message}`);
        return reply.status(401).send({ detail: "Invalid signature" });
      }
      throw error;
    }

    // Parse and validate the payload
    let event: WebhookEvent;
    try {
      const parsed = JSON.parse(rawBody.toString());
      event = WebhookEventSchema.parse(parsed);
    } catch (error) {
      fastify.log.warn(`Payload validation failed: ${error}`);
      return reply.status(422).send({ detail: `Invalid payload: ${error}` });
    }

    fastify.log.info(
      `Received valid webhook event: ${event.event_type} (id: ${event.event_id})`
    );

    // Handle different event types
    if (event.event_type === "payment.failed") {
      fastify.log.info(
        `Payment failed for order ${event.data.order_id} - skipping workflow`
      );
      return {
        status: "acknowledged",
        event_id: event.event_id,
        task_run_id: null,
        message: "Payment failed event acknowledged (no workflow triggered)",
      } satisfies WebhookResponse;
    }

    // Trigger workflow for successful payments
    if (!settings.renderUseLocalDev && !settings.workflowSlug) {
      fastify.log.warn("WORKFLOW_SLUG not configured - skipping task trigger");
      return {
        status: "accepted",
        event_id: event.event_id,
        task_run_id: null,
        message: "Event validated but workflow not configured",
      } satisfies WebhookResponse;
    }

    if (!settings.renderApiKey) {
      fastify.log.warn("RENDER_API_KEY not configured - skipping task trigger");
      return {
        status: "accepted",
        event_id: event.event_id,
        task_run_id: null,
        message: "Event validated but workflow not configured",
      } satisfies WebhookResponse;
    }

    if (!RENDER_SDK_AVAILABLE || !Render) {
      fastify.log.warn("@renderinc/sdk not installed - skipping task trigger");
      return {
        status: "accepted",
        event_id: event.event_id,
        task_run_id: null,
        message: "Event validated but render-sdk not available",
      } satisfies WebhookResponse;
    }

    // Trigger the Render Workflow task
    try {
      const renderOptions: { token: string; baseUrl?: string; useLocalDev?: boolean } = {
        token: settings.renderApiKey,
      };

      if (settings.renderUseLocalDev) {
        renderOptions.baseUrl = settings.renderLocalDevUrl;
        renderOptions.useLocalDev = true;
      }

      const render = new Render(renderOptions);

      // Build task identifier
      const taskName = "process_payment";
      const taskIdentifier = settings.renderUseLocalDev
        ? taskName
        : `${settings.workflowSlug}/${taskName}`;

      // Pass the event data as input to the workflow task
      const startedRun = await render.workflows.runTask(taskIdentifier, [event]);

      fastify.log.info(`Triggered workflow task: ${startedRun.id}`);

      const response: WebhookResponse = {
        status: "processing",
        event_id: event.event_id,
        task_run_id: startedRun.id,
        message: `Payment processing started (task: ${startedRun.id})`,
      };

      // Broadcast to SSE clients
      broadcastEvent("webhook_received", {
        response,
        event,
      });

      return response;
    } catch (error) {
      fastify.log.error(`Failed to trigger workflow: ${error}`);
      return {
        status: "accepted",
        event_id: event.event_id,
        task_run_id: null,
        message: "Event validated but workflow trigger failed - will retry internally",
      } satisfies WebhookResponse;
    }
  }
);

// Task status endpoint
fastify.get<{ Params: { taskRunId: string } }>(
  "/task-status/:taskRunId",
  async (request, reply) => {
    const settings = getSettings();
    const { taskRunId } = request.params;

    if (settings.renderUseLocalDev) {
      return {
        status: "unknown",
        message:
          "Status checking not available in local dev mode. Check the workflow server logs.",
        task_run_id: taskRunId,
      };
    }

    if (!settings.renderApiKey) {
      return reply.status(503).send({ detail: "RENDER_API_KEY not configured" });
    }

    if (!RENDER_SDK_AVAILABLE || !Render) {
      return reply.status(503).send({ detail: "render-sdk not available" });
    }

    try {
      const render = new Render({ token: settings.renderApiKey });
      const rootTask = await render.workflows.getTaskRun(taskRunId);

      // Get subtasks using direct API call with root_task_run_id filter
      // (The high-level SDK wrapper doesn't expose this parameter)
      const subtasks: Array<{
        task_run_id: string;
        task_id?: string;
        status: string;
      }> = [];

      try {
        const url = new URL("https://api.render.com/v1/task-runs");
        url.searchParams.set("rootTaskRunId", taskRunId);
        url.searchParams.set("limit", "50");

        const response = await fetch(url.toString(), {
          headers: {
            Authorization: `Bearer ${settings.renderApiKey}`,
            Accept: "application/json",
          },
        });

        if (response.ok) {
          const runs = (await response.json()) as Array<{
            id: string;
            taskId: string;
            status: string;
            parentTaskRunId: string;
            rootTaskRunId: string;
          }>;

          for (const run of runs) {
            // Skip the root task itself
            if (run.id === taskRunId) continue;
            subtasks.push({
              task_run_id: run.id,
              task_id: run.taskId,
              status: run.status,
            });
          }
        }
      } catch (error) {
        fastify.log.warn(`Could not fetch subtasks: ${error}`);
      }

      return {
        task_run_id: rootTask.id,
        status: rootTask.status,
        task_id: "taskId" in rootTask ? rootTask.taskId : null,
        retries: "retries" in rootTask ? rootTask.retries : null,
        results: "results" in rootTask ? rootTask.results : null,
        subtasks,
      };
    } catch (error) {
      fastify.log.error(`Failed to get task status: ${error}`);
      return reply
        .status(500)
        .send({ detail: `Failed to retrieve task status: ${error}` });
    }
  }
);

// Add content type parser to get raw body
fastify.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  (req, body, done) => {
    done(null, body);
  }
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
