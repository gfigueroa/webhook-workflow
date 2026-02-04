export interface PaymentData {
  payment_id: string;
  amount: number;
  currency: string;
  customer_email: string;
  customer_name: string;
  order_id: string;
  metadata: Record<string, string>;
}

export interface WebhookEvent {
  event_type: "payment.succeeded" | "payment.failed";
  event_id: string;
  timestamp: string;
  data: PaymentData;
}

export interface WebhookResponse {
  status: string;
  event_id: string;
  task_run_id: string | null;
  message: string;
}

export interface TaskStatus {
  task_run_id: string;
  status: string;
  task_id: string | null;
  retries: number | null;
  results: unknown[] | null;
  subtasks: Array<{
    task_run_id: string;
    task_id: string;
    status: string;
  }>;
}

export const DEFAULT_PAYLOAD: WebhookEvent = {
  event_type: "payment.succeeded",
  event_id: "evt_test_001",
  timestamp: new Date().toISOString(),
  data: {
    payment_id: "pi_xyz789",
    amount: 11877,
    currency: "usd",
    customer_email: "jane@example.com",
    customer_name: "Jane Smith",
    order_id: "ord_456",
    metadata: {
      product_type: "subscription",
      plan: "pro",
    },
  },
};
