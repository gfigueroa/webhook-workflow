/**
 * Zod schemas for webhook payload validation.
 * TypeScript equivalent of Python's Pydantic models.
 */

import { z } from "zod";

/**
 * Payment details from the payment provider.
 */
export const PaymentDataSchema = z.object({
  payment_id: z.string().describe("Unique payment identifier (e.g., pi_abc123)"),
  amount: z.number().int().positive().describe("Amount in cents"),
  currency: z
    .string()
    .regex(/^[a-z]{3}$/)
    .describe("ISO 4217 currency code"),
  customer_email: z.string().email().describe("Customer email address"),
  customer_name: z.string().describe("Customer full name"),
  order_id: z.string().describe("Reference to the associated order"),
  metadata: z.record(z.string()).default({}).describe("Additional context"),
});

export type PaymentData = z.infer<typeof PaymentDataSchema>;

/**
 * Webhook event payload structure.
 */
export const WebhookEventSchema = z.object({
  event_type: z
    .enum(["payment.succeeded", "payment.failed"])
    .describe("Type of event"),
  event_id: z.string().describe("Unique event ID for idempotency"),
  timestamp: z.string().datetime().describe("When the event occurred"),
  data: PaymentDataSchema.describe("Event-specific payload"),
});

export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

/**
 * Response returned by the webhook endpoint.
 */
export const WebhookResponseSchema = z.object({
  status: z.string().describe("Processing status"),
  event_id: z.string().describe("Echo of the received event ID"),
  task_run_id: z.string().nullable().describe("Workflow task run ID if triggered"),
  message: z.string().describe("Human-readable status message"),
});

export type WebhookResponse = z.infer<typeof WebhookResponseSchema>;
