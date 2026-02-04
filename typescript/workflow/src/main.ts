/**
 * Render Workflow tasks for payment processing.
 *
 * This module defines workflow tasks that process payment events asynchronously.
 * Tasks demonstrate parallel execution, sequential chaining, and retry logic.
 */

import { task, startTaskServer } from "@renderinc/sdk/workflows";

// Types for the payment event
interface PaymentData {
  payment_id: string;
  amount: number;
  currency: string;
  customer_email: string;
  customer_name: string;
  order_id: string;
  metadata?: Record<string, string>;
}

interface WebhookEvent {
  event_type: string;
  event_id: string;
  timestamp: string;
  data: PaymentData;
}

interface UpdateRecordsResult {
  task: string;
  payment_id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string;
  updated_at: string;
}

interface SendReceiptResult {
  task: string;
  to: string;
  customer_name: string;
  subject: string;
  amount_formatted: string;
  payment_id: string;
  order_id: string;
  sent_at: string;
  status: string;
}

interface NotifyFulfillmentResult {
  task: string;
  order_id: string;
  payment_id: string;
  customer_name: string;
  priority: string;
  notified_at: string;
  status: string;
}

interface ProcessPaymentResult {
  payment_id: string;
  order_id: string;
  event_id: string;
  status: string;
  actions: {
    records_updated: boolean;
    receipt_sent: boolean;
    fulfillment_notified: boolean;
  };
  records: UpdateRecordsResult;
  receipt: SendReceiptResult;
  fulfillment: NotifyFulfillmentResult;
}

/**
 * Simulate an async delay (like database or API calls).
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Update order records to mark payment as complete.
 *
 * In a real application, this would:
 * - Update the order status in the database
 * - Record the payment transaction
 * - Update inventory reservations
 */
const updateRecords = task(
  { name: "update_records" },
  async function updateRecords(
    paymentId: string,
    orderId: string,
    amount: number,
    currency: string
  ): Promise<UpdateRecordsResult> {
    console.log(`Updating records for order ${orderId} (payment: ${paymentId})`);

    // Simulate database operations
    await sleep(500);

    const result: UpdateRecordsResult = {
      task: "update_records",
      payment_id: paymentId,
      order_id: orderId,
      amount,
      currency,
      status: "paid",
      updated_at: new Date().toISOString(),
    };

    console.log(`Records updated for order ${orderId}`);
    return result;
  }
);

/**
 * Generate and send a receipt email to the customer.
 *
 * In a real application, this would:
 * - Generate a formatted receipt
 * - Send via email service (SendGrid, SES, etc.)
 * - Store a copy for records
 */
const sendReceipt = task(
  { name: "send_receipt" },
  async function sendReceipt(
    paymentId: string,
    customerEmail: string,
    customerName: string,
    amount: number,
    currency: string,
    orderId: string
  ): Promise<SendReceiptResult> {
    console.log(`Sending receipt to ${customerEmail} for payment ${paymentId}`);

    // Format amount for display
    const amountFormatted = `$${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;

    // Simulate email generation and sending
    await sleep(300);

    const receipt: SendReceiptResult = {
      task: "send_receipt",
      to: customerEmail,
      customer_name: customerName,
      subject: `Payment Receipt - ${amountFormatted}`,
      amount_formatted: amountFormatted,
      payment_id: paymentId,
      order_id: orderId,
      sent_at: new Date().toISOString(),
      status: "sent",
    };

    console.log(`Receipt sent to ${customerEmail}`);
    return receipt;
  }
);

/**
 * Notify the fulfillment system to begin order processing.
 *
 * This task has retry logic configured to handle transient failures
 * when communicating with external fulfillment systems.
 *
 * In a real application, this would:
 * - Call the fulfillment/warehouse API
 * - Create shipping labels
 * - Update tracking information
 */
const notifyFulfillment = task(
  {
    name: "notify_fulfillment",
    retry: {
      maxRetries: 3,
      waitDurationMs: 1000, // Base delay in ms
      backoffScaling: 2.0, // Exponential backoff multiplier
    },
  },
  async function notifyFulfillment(
    orderId: string,
    paymentId: string,
    customerName: string,
    metadata: Record<string, string>
  ): Promise<NotifyFulfillmentResult> {
    console.log(`Notifying fulfillment system for order ${orderId}`);

    // Simulate calling external fulfillment API
    await sleep(400);

    // Determine priority based on metadata
    const priority = metadata?.plan === "pro" ? "express" : "standard";

    const fulfillment: NotifyFulfillmentResult = {
      task: "notify_fulfillment",
      order_id: orderId,
      payment_id: paymentId,
      customer_name: customerName,
      priority,
      notified_at: new Date().toISOString(),
      status: "notified",
    };

    console.log(`Fulfillment notified for order ${orderId} (priority: ${priority})`);
    return fulfillment;
  }
);

/**
 * Root task that orchestrates payment processing.
 *
 * This task:
 * 1. Extracts payment data from the event
 * 2. Runs update_records and send_receipt in parallel
 * 3. After both complete, notifies the fulfillment system
 */
task(
  { name: "process_payment" },
  async function processPayment(event: WebhookEvent): Promise<ProcessPaymentResult> {
    const eventId = event.event_id;
    const eventType = event.event_type;
    const data = event.data;

    console.log(`Processing payment event ${eventId} (type: ${eventType})`);

    const paymentId = data.payment_id;
    const orderId = data.order_id;
    const amount = data.amount;
    const currency = data.currency;
    const customerEmail = data.customer_email;
    const customerName = data.customer_name;
    const metadata = data.metadata || {};

    // Run update_records and send_receipt in parallel
    console.log("Starting parallel tasks: update_records, send_receipt");

    const [recordsResult, receiptResult] = await Promise.all([
      updateRecords(paymentId, orderId, amount, currency),
      sendReceipt(paymentId, customerEmail, customerName, amount, currency, orderId),
    ]);

    console.log("Parallel tasks completed, notifying fulfillment");

    // After parallel tasks complete, notify fulfillment
    const fulfillmentResult = await notifyFulfillment(
      orderId,
      paymentId,
      customerName,
      metadata
    );

    // Compile final result
    const result: ProcessPaymentResult = {
      payment_id: paymentId,
      order_id: orderId,
      event_id: eventId,
      status: "completed",
      actions: {
        records_updated: recordsResult.status === "paid",
        receipt_sent: receiptResult.status === "sent",
        fulfillment_notified: fulfillmentResult.status === "notified",
      },
      records: recordsResult,
      receipt: receiptResult,
      fulfillment: fulfillmentResult,
    };

    console.log(`Payment processing completed for event ${eventId}`);
    return result;
  }
);

// Start the task server
startTaskServer();
