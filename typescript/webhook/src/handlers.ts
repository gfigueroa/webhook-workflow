/**
 * Route handlers for the webhook service.
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import { Render } from "@renderinc/sdk";

import { getSettings } from "./config.js";
import { WebhookEventSchema, type WebhookEvent, type WebhookResponse } from "./types.js";
import {
  verifySignature,
  SignatureVerificationError,
  TimestampValidationError,
} from "./security.js";

// Module-level SDK client (lazy initialized, reused across handlers)
let renderClient: Render | null = null;

function getRenderClient(): Render {
  if (!renderClient) {
    const settings = getSettings();
    const options: { token: string; baseUrl?: string; useLocalDev?: boolean } = {
      token: settings.renderApiKey,
    };
    if (settings.renderUseLocalDev) {
      options.baseUrl = settings.renderLocalDevUrl;
      options.useLocalDev = true;
    }
    renderClient = new Render(options);
  }
  return renderClient;
}

// SSE clients for real-time updates
const sseClients: Set<FastifyReply> = new Set();

/** Broadcast an event to all connected SSE clients */
export function broadcastEvent(eventType: string, data: object): void {
  const message = JSON.stringify({ type: eventType, data });
  for (const client of sseClients) {
    client.raw.write(`event: webhook\ndata: ${message}\n\n`);
  }
}

/** GET /events - SSE endpoint for real-time updates */
export async function eventsHandler(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> {
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

  return reply;
}

/** POST /webhook - Receive and process webhook events */
export async function webhookHandler(
  request: FastifyRequest<{
    Headers: {
      "x-webhook-signature": string;
      "x-webhook-timestamp": string;
    };
  }>,
  reply: FastifyReply
): Promise<WebhookResponse> {
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
      request.log.warn(`Timestamp validation failed: ${error.message}`);
      reply.status(401);
      return {
        status: "error",
        event_id: "",
        task_run_id: null,
        message: `Timestamp validation failed: ${error.message}`,
      };
    }
    if (error instanceof SignatureVerificationError) {
      request.log.warn(`Signature verification failed: ${error.message}`);
      reply.status(401);
      return {
        status: "error",
        event_id: "",
        task_run_id: null,
        message: "Invalid signature",
      };
    }
    throw error;
  }

  // Parse and validate the payload
  let event: WebhookEvent;
  try {
    const parsed = JSON.parse(rawBody.toString());
    event = WebhookEventSchema.parse(parsed);
  } catch (error) {
    request.log.warn(`Payload validation failed: ${error}`);
    reply.status(422);
    return {
      status: "error",
      event_id: "",
      task_run_id: null,
      message: `Invalid payload: ${error}`,
    };
  }

  request.log.info(`Received valid webhook event: ${event.event_type} (id: ${event.event_id})`);

  // Handle payment.failed - acknowledge but don't trigger workflow
  if (event.event_type === "payment.failed") {
    request.log.info(`Payment failed for order ${event.data.order_id} - skipping workflow`);
    return {
      status: "acknowledged",
      event_id: event.event_id,
      task_run_id: null,
      message: "Payment failed event acknowledged (no workflow triggered)",
    };
  }

  // Check workflow configuration
  if (!settings.renderUseLocalDev && !settings.workflowSlug) {
    request.log.warn("WORKFLOW_SLUG not configured - skipping task trigger");
    return {
      status: "accepted",
      event_id: event.event_id,
      task_run_id: null,
      message: "Event validated but workflow not configured",
    };
  }

  if (!settings.renderApiKey) {
    request.log.warn("RENDER_API_KEY not configured - skipping task trigger");
    return {
      status: "accepted",
      event_id: event.event_id,
      task_run_id: null,
      message: "Event validated but workflow not configured",
    };
  }

  // Trigger the Render Workflow task
  try {
    const render = getRenderClient();

    const taskName = "process_payment";
    const taskIdentifier = settings.renderUseLocalDev
      ? taskName
      : `${settings.workflowSlug}/${taskName}`;

    const startedRun = await render.workflows.runTask(taskIdentifier, [event]);

    request.log.info(`Triggered workflow task: ${startedRun.id}`);

    const response: WebhookResponse = {
      status: "processing",
      event_id: event.event_id,
      task_run_id: startedRun.id,
      message: `Payment processing started (task: ${startedRun.id})`,
    };

    broadcastEvent("webhook_received", { response, event });

    return response;
  } catch (error) {
    request.log.error(`Failed to trigger workflow: ${error}`);
    return {
      status: "accepted",
      event_id: event.event_id,
      task_run_id: null,
      message: "Event validated but workflow trigger failed",
    };
  }
}

/** GET /task-status/:taskRunId - Check workflow task status */
export async function taskStatusHandler(
  request: FastifyRequest<{ Params: { taskRunId: string } }>,
  reply: FastifyReply
): Promise<object> {
  const settings = getSettings();
  const { taskRunId } = request.params;

  if (settings.renderUseLocalDev) {
    return {
      status: "unknown",
      message: "Status checking not available in local dev mode. Check the workflow server logs.",
      task_run_id: taskRunId,
    };
  }

  if (!settings.renderApiKey) {
    reply.status(503);
    return { detail: "RENDER_API_KEY not configured" };
  }

  try {
    const render = getRenderClient();
    const rootTask = await render.workflows.getTaskRun(taskRunId);

    // Get subtasks using direct API call with root_task_run_id filter
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
        }>;

        for (const run of runs) {
          if (run.id === taskRunId) continue;
          subtasks.push({
            task_run_id: run.id,
            task_id: run.taskId,
            status: run.status,
          });
        }
      }
    } catch (error) {
      request.log.warn(`Could not fetch subtasks: ${error}`);
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
    request.log.error(`Failed to get task status: ${error}`);
    reply.status(500);
    return { detail: "Failed to retrieve task status" };
  }
}
