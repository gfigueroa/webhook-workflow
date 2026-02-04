import { type WorkflowConfig, WorkflowVisualizer } from "workflow-visualizer";

interface HowItWorksProps {
  onBack: () => void;
}

const workflowConfig: WorkflowConfig = {
  title: "WEBHOOK DEMO",
  subtitle: "How Render Workflows process payment events",
  nodes: [
    {
      id: "webhook",
      label: "Webhook POST",
      type: "trigger",
      description:
        "External payment system sends a signed webhook with payment data. The webhook service validates the HMAC-SHA256 signature before processing.",
      position: { x: 300, y: 50 },
      details: [
        { label: "Endpoint", value: "/webhook" },
        { label: "Auth", value: "HMAC-SHA256" },
        { label: "Event", value: "payment.succeeded" },
      ],
    },
    {
      id: "process_payment",
      label: "process_payment",
      type: "orchestrator",
      description:
        "Root task that orchestrates the payment processing workflow. Extracts payment data and coordinates subtasks.",
      position: { x: 300, y: 180 },
      details: [
        { label: "Type", value: "Orchestrator" },
        { label: "Subtasks", value: "3" },
        { label: "Pattern", value: "Fan-out/Fan-in" },
      ],
    },
    {
      id: "update_records",
      label: "update_records",
      type: "task",
      description:
        "Updates order records in the database to mark payment as complete. Records the payment transaction and updates inventory reservations.",
      position: { x: 150, y: 320 },
      details: [
        { label: "Execution", value: "Parallel" },
        { label: "Updates", value: "Order status, inventory" },
      ],
    },
    {
      id: "send_receipt",
      label: "send_receipt",
      type: "task",
      description:
        "Generates and sends a receipt email to the customer via email service (SendGrid, SES, etc.).",
      position: { x: 450, y: 320 },
      details: [
        { label: "Execution", value: "Parallel" },
        { label: "Output", value: "Email receipt" },
      ],
    },
    {
      id: "notify_fulfillment",
      label: "notify_fulfillment",
      type: "task",
      description:
        "Notifies the fulfillment system to begin order processing. Creates shipping labels and updates tracking information.",
      position: { x: 300, y: 460 },
      details: [
        { label: "Execution", value: "Sequential" },
        { label: "Retry", value: "3x with backoff" },
        { label: "Depends on", value: "Parallel tasks" },
      ],
    },
  ],
  edges: [
    {
      id: "webhook-process",
      from: "webhook",
      to: "process_payment",
      style: "solid",
    },
    {
      id: "process-update",
      from: "process_payment",
      to: "update_records",
      label: "parallel",
      style: "solid",
    },
    {
      id: "process-receipt",
      from: "process_payment",
      to: "send_receipt",
      label: "parallel",
      style: "solid",
    },
    {
      id: "update-fulfill",
      from: "update_records",
      to: "notify_fulfillment",
      style: "dashed",
    },
    {
      id: "receipt-fulfill",
      from: "send_receipt",
      to: "notify_fulfillment",
      style: "dashed",
    },
  ],
  defaultTrigger: "webhook",
  triggerFlows: [
    {
      triggerId: "webhook",
      nodes: [
        "webhook",
        "process_payment",
        "update_records",
        "send_receipt",
        "notify_fulfillment",
      ],
      edges: [
        "webhook-process",
        "process-update",
        "process-receipt",
        "update-fulfill",
        "receipt-fulfill",
      ],
      animationSequence: [
        {
          id: "step1",
          activeNodes: ["webhook"],
          activeEdges: [],
          duration: 2000,
          title: "Webhook Received",
          description:
            "Payment provider sends a signed webhook to /webhook endpoint. The service validates the HMAC-SHA256 signature and timestamp.",
        },
        {
          id: "step2",
          activeNodes: ["webhook", "process_payment"],
          activeEdges: ["webhook-process"],
          duration: 2000,
          title: "Workflow Triggered",
          description:
            "After validation, the webhook service triggers the process_payment task via Render Workflows API.",
        },
        {
          id: "step3",
          activeNodes: ["process_payment", "update_records", "send_receipt"],
          activeEdges: ["process-update", "process-receipt"],
          duration: 2500,
          title: "Parallel Execution",
          description:
            "process_payment spawns update_records and send_receipt tasks in parallel using asyncio.gather / Promise.all.",
        },
        {
          id: "step4",
          activeNodes: ["update_records", "send_receipt", "notify_fulfillment"],
          activeEdges: ["update-fulfill", "receipt-fulfill"],
          duration: 2000,
          title: "Sequential Completion",
          description:
            "After both parallel tasks complete, notify_fulfillment runs to alert the shipping system. Configured with 3x retry and exponential backoff.",
        },
        {
          id: "step5",
          activeNodes: ["notify_fulfillment"],
          activeEdges: [],
          duration: 1500,
          title: "Workflow Complete",
          description:
            "All tasks finished. Results are aggregated and returned. The webhook caller receives a task_run_id for status tracking.",
        },
      ],
    },
  ],
};

export function HowItWorks({ onBack }: HowItWorksProps) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-7xl px-4 py-8">
        <div className="relative">
          <button
            type="button"
            onClick={onBack}
            className="absolute right-0 top-0 z-10 border border-zinc-600 px-4 py-2 text-sm text-zinc-300 hover:border-zinc-500 hover:text-white"
          >
            Back to Demo
          </button>
          <WorkflowVisualizer
            config={workflowConfig}
            defaultSelectedNode="webhook"
          />
        </div>
      </div>
    </div>
  );
}
