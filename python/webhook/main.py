"""FastAPI webhook service that validates signatures and triggers Render Workflows."""

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request, status
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from sse_starlette.sse import EventSourceResponse

from config import get_settings

# SSE clients for real-time updates
sse_clients: list[asyncio.Queue] = []

# render-sdk is optional for local development without workflow integration
try:
    from render_sdk import Render

    RENDER_SDK_AVAILABLE = True
except ImportError:
    Render = None  # type: ignore[misc, assignment]
    RENDER_SDK_AVAILABLE = False
from models import WebhookEvent, WebhookResponse
from security import (
    SignatureVerificationError,
    TimestampValidationError,
    verify_signature,
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler for startup/shutdown."""
    settings = get_settings()

    # Log configuration status on startup
    if settings.render_use_local_dev:
        logger.info(f"Local dev mode enabled - using task server at {settings.render_local_dev_url}")
    
    if not settings.render_api_key:
        logger.warning(
            "RENDER_API_KEY not set - workflow triggering will fail. "
            "Set this environment variable to enable workflow integration."
        )

    if not settings.render_use_local_dev and not settings.workflow_slug:
        logger.warning(
            "WORKFLOW_SLUG not set - workflow triggering will fail in production. "
            "Set this to your Workflow service name on Render."
        )

    logger.info("Webhook service started")
    yield
    logger.info("Webhook service shutting down")


app = FastAPI(
    title="Webhook Demo with Render Workflows",
    description="Securely receive webhooks with HMAC signature validation and trigger async tasks",
    version="1.0.0",
    lifespan=lifespan,
)

# Serve static files for the tester UI
# Production: copied to ./static during build (from frontend/dist)
# Local dev: use frontend/dist after running `npm run build` in frontend/
static_dir = Path(__file__).parent / "static"
if not static_dir.exists():
    static_dir = Path(__file__).parent.parent.parent / "frontend" / "dist"

# Mount Vite's assets directory
assets_dir = static_dir / "assets" if static_dir.exists() else None
if assets_dir and assets_dir.exists():
    app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")


@app.get("/")
async def root():
    """Serve the webhook tester UI."""
    if static_dir.exists():
        index_path = static_dir / "index.html"
        if index_path.exists():
            return FileResponse(index_path)
    return {"message": "Webhook service running. POST to /webhook to trigger workflows. Build frontend with: cd frontend && npm run build"}


@app.get("/health")
async def health_check() -> dict:
    """Health check endpoint for Render."""
    return {"status": "healthy"}


async def broadcast_event(event_type: str, data: dict):
    """Broadcast an event to all connected SSE clients."""
    message = json.dumps({"type": event_type, "data": data})
    for queue in sse_clients:
        await queue.put(message)


@app.get("/events")
async def sse_events(request: Request):
    """Server-Sent Events endpoint for real-time webhook updates."""
    queue: asyncio.Queue = asyncio.Queue()
    sse_clients.append(queue)
    
    async def event_generator():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=30)
                    yield {"event": "webhook", "data": message}
                except asyncio.TimeoutError:
                    yield {"event": "ping", "data": ""}
        finally:
            sse_clients.remove(queue)
    
    return EventSourceResponse(event_generator())


@app.post("/webhook", response_model=WebhookResponse)
async def receive_webhook(
    request: Request,
    x_webhook_signature: str = Header(..., description="HMAC-SHA256 signature"),
    x_webhook_timestamp: str = Header(..., description="Unix timestamp of request"),
) -> WebhookResponse:
    """
    Receive and process webhook events.

    This endpoint:
    1. Validates the HMAC-SHA256 signature (authentication)
    2. Checks the timestamp is recent (replay protection)
    3. Parses and validates the payload (schema validation)
    4. Triggers a Render Workflow task for async processing

    Headers required:
    - X-Webhook-Signature: sha256=<hex_signature>
    - X-Webhook-Timestamp: <unix_timestamp>
    """
    settings = get_settings()

    # Get raw body for signature verification
    raw_body = await request.body()

    # Verify signature and timestamp
    try:
        verify_signature(
            payload=raw_body,
            signature_header=x_webhook_signature,
            timestamp=x_webhook_timestamp,
            secret=settings.webhook_secret,
            tolerance_seconds=settings.timestamp_tolerance_seconds,
        )
    except TimestampValidationError as e:
        logger.warning(f"Timestamp validation failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Timestamp validation failed: {e}",
        )
    except SignatureVerificationError as e:
        logger.warning(f"Signature verification failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid signature",
        )

    # Parse and validate the payload
    try:
        event = WebhookEvent.model_validate_json(raw_body)
    except Exception as e:
        logger.warning(f"Payload validation failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid payload: {e}",
        )

    logger.info(f"Received valid webhook event: {event.event_type} (id: {event.event_id})")

    # Handle different event types
    if event.event_type == "payment.failed":
        logger.info(f"Payment failed for order {event.data.order_id} - skipping workflow")
        return WebhookResponse(
            status="acknowledged",
            event_id=event.event_id,
            task_run_id=None,
            message="Payment failed event acknowledged (no workflow triggered)",
        )

    # Trigger workflow for successful payments
    if not settings.render_use_local_dev and not settings.workflow_slug:
        logger.warning("WORKFLOW_SLUG not configured - skipping task trigger")
        return WebhookResponse(
            status="accepted",
            event_id=event.event_id,
            task_run_id=None,
            message="Event validated but workflow not configured",
        )

    if not settings.render_api_key:
        logger.warning("RENDER_API_KEY not configured - skipping task trigger")
        return WebhookResponse(
            status="accepted",
            event_id=event.event_id,
            task_run_id=None,
            message="Event validated but workflow not configured",
        )

    if not RENDER_SDK_AVAILABLE:
        logger.warning("render-sdk not installed - skipping task trigger")
        return WebhookResponse(
            status="accepted",
            event_id=event.event_id,
            task_run_id=None,
            message="Event validated but render-sdk not available",
        )

    # Trigger the Render Workflow task
    try:
        # Explicitly pass base_url for local dev mode
        # (pydantic-settings doesn't propagate .env to os.environ, which SDK checks)
        if settings.render_use_local_dev:
            render = Render(
                token=settings.render_api_key,
                base_url=settings.render_local_dev_url,
            )  # type: ignore[misc]
        else:
            render = Render(token=settings.render_api_key)  # type: ignore[misc]

        # Pass the event data as input to the workflow task
        task_input = [event.model_dump(mode="json")]

        # Build task identifier:
        #   Local dev: just the task name
        #   Production: <workflow-slug>/<task-name>
        task_name = "process_payment"
        if settings.render_use_local_dev:
            task_identifier = task_name
        else:
            task_identifier = f"{settings.workflow_slug}/{task_name}"

        started_run = await render.workflows.run_task(
            task_identifier=task_identifier,
            input_data=task_input,
        )

        logger.info(f"Triggered workflow task: {started_run.id}")

        response = WebhookResponse(
            status="processing",
            event_id=event.event_id,
            task_run_id=started_run.id,
            message=f"Payment processing started (task: {started_run.id})",
        )
        
        # Broadcast to SSE clients (use mode="json" for datetime serialization)
        await broadcast_event("webhook_received", {
            "response": response.model_dump(mode="json"),
            "event": event.model_dump(mode="json"),
        })
        
        return response

    except Exception as e:
        logger.error(f"Failed to trigger workflow: {e}")
        # Return 202 Accepted - we validated the webhook, just couldn't trigger the task
        # The sender should not retry based on our internal failures
        return WebhookResponse(
            status="accepted",
            event_id=event.event_id,
            task_run_id=None,
            message="Event validated but workflow trigger failed - will retry internally",
        )


@app.get("/task-status/{task_run_id}")
async def get_task_status(task_run_id: str) -> dict:
    """
    Check the status of a workflow task run.
    
    Note: This only works in production with a valid Render API key.
    The local dev server doesn't support status queries.
    """
    settings = get_settings()

    if settings.render_use_local_dev:
        return {
            "status": "unknown",
            "message": "Status checking not available in local dev mode. Check the workflow server logs.",
            "task_run_id": task_run_id,
        }

    if not settings.render_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="RENDER_API_KEY not configured",
        )

    if not RENDER_SDK_AVAILABLE:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="render-sdk not available",
        )

    try:
        render = Render(token=settings.render_api_key)  # type: ignore[misc]
        
        # Get the root task details
        root_task = await render.workflows.get_task_run(task_run_id)
        
        # Fetch subtasks using low-level API with root_task_run_id filter
        # (The high-level SDK wrapper doesn't expose this parameter)
        subtasks = []
        try:
            from render_sdk.public_api.api.workflows import list_task_runs
            
            response = await list_task_runs.asyncio_detailed(
                client=render.client.internal,
                root_task_run_id=[task_run_id],
                limit=50,
            )
            
            if response.parsed and isinstance(response.parsed, list):
                for run in response.parsed:
                    # Skip the root task itself
                    if run.id == task_run_id:
                        continue
                    subtasks.append({
                        "task_run_id": run.id,
                        "task_id": run.task_id,
                        "status": run.status.value if hasattr(run.status, 'value') else str(run.status),
                    })
        except Exception as e:
            logger.warning(f"Could not fetch subtasks: {e}")
        
        return {
            "task_run_id": root_task.id,
            "status": root_task.status.value if hasattr(root_task.status, 'value') else str(root_task.status),
            "task_id": root_task.task_id if hasattr(root_task, 'task_id') else None,
            "retries": root_task.retries if hasattr(root_task, 'retries') else None,
            "results": root_task.results if hasattr(root_task, 'results') else None,
            "subtasks": subtasks,
        }
    except Exception as e:
        logger.error(f"Failed to get task status: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to retrieve task status: {e}",
        )


if __name__ == "__main__":
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "main:app",
        host=settings.host,
        port=settings.port,
        reload=True,
    )
