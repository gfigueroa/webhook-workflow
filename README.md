# Webhook + Render Workflows Demo

This template demonstrates how to build a secure webhook endpoint that validates requests using HMAC-SHA256 signatures and delegates processing to [Render Workflows](https://render.com/docs/workflows) for reliable async execution.

**Use case:** A payment provider (like Stripe) sends a `payment.succeeded` webhook. The webhook service validates the signature, then triggers a workflow that:

1. Updates order records (marks as paid)
2. Sends a receipt email to the customer
3. Notifies the fulfillment system

All without blocking the webhook response or managing queue infrastructure.

## Architecture

```
Payment Provider                    Render Platform
      │                                   │
      │  POST /webhook                    │
      │  + signature header               │
      ▼                                   ▼
┌─────────────────┐             ┌─────────────────────┐
│ Webhook Service │────────────▶│   Render Workflow   │
│                 │  trigger    │                     │
│                 │             │  ┌───────────────┐  │
│ • Validate sig  │             │  │process_payment│  │
│ • Check timestamp│            │  └───────┬───────┘  │
│ • Parse payload │             │          │          │
│ • Return 200    │             │    ┌─────┴─────┐    │
└─────────────────┘             │    ▼           ▼    │
                                │ update_    send_    │
                                │ records    receipt  │
                                │    │           │    │
                                │    └─────┬─────┘    │
                                │          ▼          │
                                │   notify_fulfillment│
                                └─────────────────────┘
```

## Project structure

This template includes both TypeScript and Python implementations:

```
webhook-workflows/
├── typescript/
│   ├── webhook/             # Fastify webhook receiver
│   │   ├── src/
│   │   │   ├── index.ts     # Server setup and routes
│   │   │   ├── handlers.ts  # Route handlers (business logic)
│   │   │   ├── config.ts    # Environment configuration
│   │   │   ├── security.ts  # HMAC signature validation
│   │   │   └── types.ts     # Zod schemas for validation
│   │   └── package.json
│   └── workflows/           # Render Workflow tasks
│       ├── src/
│       │   └── main.ts      # Task definitions
│       └── package.json
├── python/
│   ├── webhook/             # FastAPI webhook receiver
│   │   ├── main.py          # Server setup and routes
│   │   ├── handlers.py      # Route handlers (business logic)
│   │   ├── config.py        # Environment configuration
│   │   ├── security.py      # HMAC signature validation
│   │   ├── models.py        # Pydantic models for validation
│   │   └── requirements.txt
│   └── workflows/           # Render Workflow tasks
│       ├── main.py          # Task definitions
│       └── requirements.txt
├── frontend/                # React tester UI
│   └── ...
└── render.yaml              # Blueprint for deployment
```

## Deploy to Render

### 1. Deploy the webhook service

Click the button below to deploy the webhook service:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/render-examples/webhook-workflows)

During deployment, you'll be prompted for:

- **RENDER_API_KEY**: Your Render API key ([create one here](https://render.com/docs/api#1-create-an-api-key))
- **WORKFLOW_SLUG**: Leave blank for now; set after creating the workflow

### 2. Create the workflow service

Workflows aren't yet supported in Blueprints, so create one manually:

1. In the Render Dashboard, click **New > Workflow**
2. Connect your repo (or fork of this template)
3. Configure the workflow:
   - **Root Directory**: `python/workflows` (or `typescript/workflows`)
   - **Build Command**: `pip install -r requirements.txt` (or `npm install && npm run build`)
   - **Start Command**: `python main.py` (or `npm start`)
4. Click **Deploy Workflow**

### 3. Connect the services

After the workflow deploys:

1. Go to the workflow's **Tasks** page
2. Click on `process-payment` and copy the **task slug** (format: `workflow-name/process-payment`)
3. Go to your webhook service's **Environment** settings
4. Set `WORKFLOW_SLUG` to the copied task slug

## Webhook security

This template implements industry-standard webhook security:

### HMAC-SHA256 signatures

Every request must include:

- `X-Webhook-Signature`: `sha256=<hex_signature>`
- `X-Webhook-Timestamp`: `<unix_timestamp>`

The signature is computed as:

```
HMAC-SHA256(key=WEBHOOK_SECRET, message=timestamp + "." + raw_body)
```

### Replay attack protection

Requests with timestamps older than 5 minutes are rejected, preventing captured requests from being replayed later.

### Constant-time comparison

Signatures are compared using constant-time functions to prevent timing attacks.

## Test the webhook

### Using the tester UI

The webhook service includes a built-in tester UI. Open your webhook URL in a browser to access it. The UI lets you:

- Generate signed test payloads
- Send requests to the webhook endpoint
- View real-time responses via SSE

### Generate a signed request (CLI)

```bash
# Set your webhook secret (from the Render Dashboard or local .env)
export WEBHOOK_SECRET="your-secret-here"

# Set your webhook URL
export WEBHOOK_URL="https://your-webhook.onrender.com/webhook"

# Generate timestamp and payload
TIMESTAMP=$(date +%s)
PAYLOAD='{"event_type":"payment.succeeded","event_id":"evt_test_'$(date +%s)'","timestamp":"2026-01-23T10:30:00Z","data":{"payment_id":"pi_test123","amount":11877,"currency":"usd","customer_email":"jane@example.com","customer_name":"Jane Smith","order_id":"ord_456","metadata":{"product_type":"subscription","plan":"pro"}}}'

# Compute signature
SIGNATURE=$(echo -n "${TIMESTAMP}.${PAYLOAD}" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | cut -d' ' -f2)

# Send the request
curl -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: sha256=${SIGNATURE}" \
  -H "X-Webhook-Timestamp: ${TIMESTAMP}" \
  -d "$PAYLOAD"
```

### Expected response

```json
{
  "status": "processing",
  "event_id": "evt_test_1706012345",
  "task_run_id": "trn-abc123...",
  "message": "Payment processing started (task: trn-abc123...)"
}
```

### View workflow results

1. Go to your workflow in the Render Dashboard
2. Click **Tasks > process-payment > Runs**
3. Select the task run to see logs and results

## Local development

You can run and test the full webhook-to-workflow pipeline locally using the [Render CLI](https://render.com/docs/cli).

### Prerequisites

- [Install the Render CLI](https://render.com/docs/cli#setup) (v2.11.0 or later)
- Node.js 20+ (for TypeScript) or Python 3.11+ (for Python)

### Start the task server

The Render CLI runs a local task server that simulates the workflow execution lifecycle. In a terminal, start it with your workflow's start command:

**TypeScript:**

```bash
cd typescript/workflows
npm install && npm run build
render workflows dev -- npm start
```

**Python:**

```bash
cd python/workflows
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
render workflows dev -- python main.py
```

The task server starts on port `8120`. To use a different port:

```bash
render workflows dev --port 9000 -- python main.py
```

### Start the webhook service

In a separate terminal, start the webhook service with local dev mode enabled:

**TypeScript:**

```bash
cd typescript/webhook
npm install
RENDER_USE_LOCAL_DEV=true npm run dev
```

**Python:**

```bash
cd python/webhook
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
RENDER_USE_LOCAL_DEV=true python main.py
```

Setting `RENDER_USE_LOCAL_DEV=true` points the webhook service at your local task server instead of the Render API. You can also set this in a `.env` file:

```bash
WEBHOOK_SECRET=dev-secret-for-testing
RENDER_USE_LOCAL_DEV=true
# RENDER_LOCAL_DEV_URL=http://localhost:9000  # Only if using a non-default port
```

### Build the frontend

```bash
cd frontend
npm install
npm run build
```

The webhook service serves the built frontend automatically.

### Trigger tasks from the CLI

With the task server running, you can also list and run tasks directly from the CLI:

```bash
render workflows tasks list --local
render workflows taskruns start process_payment --local --input='[{"event_type":"payment.succeeded","event_id":"evt_test","timestamp":"2026-01-23T10:30:00Z","data":{"payment_id":"pi_123","amount":5000,"currency":"usd","customer_email":"jane@example.com","customer_name":"Jane Smith","order_id":"ord_456","metadata":{}}}]'
```

### Test without workflows

Without `RENDER_USE_LOCAL_DEV` or a running task server, the webhook service validates signatures and payloads but skips workflow triggering. This is useful for testing webhook security logic in isolation.

For more details, see [Local Development for Workflows](https://render.com/docs/workflows-local-development).

## Payload schema

The webhook expects this payload structure:

```json
{
  "event_type": "payment.succeeded",
  "event_id": "evt_unique_id",
  "timestamp": "2026-01-23T10:30:00Z",
  "data": {
    "payment_id": "pi_abc123",
    "amount": 11877,
    "currency": "usd",
    "customer_email": "customer@example.com",
    "customer_name": "Jane Smith",
    "order_id": "ord_456",
    "metadata": {
      "product_type": "subscription",
      "plan": "pro"
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `event_type` | string | `payment.succeeded` or `payment.failed` |
| `event_id` | string | Unique event ID for idempotency |
| `timestamp` | ISO 8601 | When the event occurred |
| `data.payment_id` | string | Unique payment identifier |
| `data.amount` | integer | Amount in cents |
| `data.currency` | string | ISO 4217 currency code (3 lowercase letters) |
| `data.customer_email` | string | Customer email address |
| `data.customer_name` | string | Customer full name |
| `data.order_id` | string | Associated order identifier |
| `data.metadata` | object | Optional key-value pairs |

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `WEBHOOK_SECRET` | Yes | Secret key for HMAC signature validation |
| `RENDER_API_KEY` | Yes* | Render API key for triggering workflows |
| `WORKFLOW_SLUG` | Yes* | Task slug (e.g., `my-workflow/process-payment`) |

*Required for workflow integration. The webhook validates requests without these but won't trigger tasks.

## Workflow tasks

The workflow demonstrates several patterns:

### Parallel execution

`update_records` and `send_receipt` run simultaneously:

**TypeScript:**
```typescript
const [recordsResult, receiptResult] = await Promise.all([
  updateRecords(paymentId, orderId, amount, currency),
  sendReceipt(paymentId, customerEmail, customerName, amount, currency, orderId),
]);
```

**Python:**
```python
records_result, receipt_result = await asyncio.gather(
    update_records(payment_id, order_id, amount, currency),
    send_receipt(payment_id, customer_email, customer_name, amount, currency, order_id),
)
```

### Sequential chaining

`notify_fulfillment` runs only after the parallel tasks complete.

### Retry logic

`notify_fulfillment` has exponential backoff configured for transient failures:

**TypeScript:**
```typescript
const notifyFulfillment = task(
  {
    name: "notify_fulfillment",
    retry: {
      maxRetries: 3,
      waitDurationMs: 1000,
      backoffScaling: 2.0,  // 1s, 2s, 4s
    },
  },
  async (orderId, paymentId, customerName, metadata) => { ... }
);
```

**Python:**
```python
@app.task(retry=Retry(max_retries=3, wait_duration_ms=1000, backoff_scaling=2.0))
async def notify_fulfillment(order_id, payment_id, customer_name, metadata):
    ...
```

## Learn more

- [Render Workflows documentation](https://render.com/docs/workflows)
- [Workflows SDK for Python](https://render.com/docs/workflows-sdk-python)
- [Workflows SDK for TypeScript](https://render.com/docs/workflows-sdk-typescript)
- [Running Workflow Tasks](https://render.com/docs/workflows-running)
- [Local Development for Workflows](https://render.com/docs/workflows-local-development)
