/**
 * Environment configuration for the webhook service.
 * TypeScript equivalent of Python's pydantic-settings.
 */

import "dotenv/config";

export interface Settings {
  // Webhook security
  webhookSecret: string;

  // Render Workflows
  renderApiKey: string;
  // Workflow slug (the service name on Render)
  // The code automatically appends the task name for production
  workflowSlug: string;

  // Local development (set RENDER_USE_LOCAL_DEV=true to use local task server)
  // See: https://render.com/docs/workflows-local-development
  renderUseLocalDev: boolean;
  renderLocalDevUrl: string;

  // Server settings
  host: string;
  port: number;

  // Security settings
  timestampToleranceSeconds: number;

  // Demo mode (enables rate limiting on /webhook)
  demoMode: boolean;
}

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === "true" || value === "1";
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

let cachedSettings: Settings | null = null;

export function getSettings(): Settings {
  if (cachedSettings) return cachedSettings;

  cachedSettings = {
    // Webhook security
    webhookSecret: process.env.WEBHOOK_SECRET || "demo-webhook-secret",

    // Render Workflows
    renderApiKey: process.env.RENDER_API_KEY || "",
    workflowSlug: process.env.WORKFLOW_SLUG || "",

    // Local development
    renderUseLocalDev: getEnvBoolean("RENDER_USE_LOCAL_DEV", false),
    renderLocalDevUrl: process.env.RENDER_LOCAL_DEV_URL || "http://localhost:8120",

    // Server settings
    host: process.env.HOST || "0.0.0.0",
    port: getEnvNumber("PORT", 10000),

    // Security settings
    timestampToleranceSeconds: getEnvNumber("TIMESTAMP_TOLERANCE_SECONDS", 300),

    // Demo mode
    demoMode: getEnvBoolean("DEMO_MODE", false),
  };

  return cachedSettings;
}
