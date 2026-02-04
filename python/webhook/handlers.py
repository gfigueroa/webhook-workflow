"""Route handlers for the webhook service."""

import asyncio
import json
import logging

from fastapi import HTTPException, Request, status
from render_sdk import Render
from sse_starlette.sse import EventSourceResponse

from config import get_settings
from models import WebhookEvent, WebhookResponse
from security import (
    SignatureVerificationError,
    TimestampValidationError,
    verify_signature,
)

logger = logging.getLogger(__name__)

# Module-level SDK client (lazy initialized, reused across handlers)
_render: Render | None = None


def get_render_client() -> Render:
    """Get cached Render client."""
    global _render
    if _render is None:
        settings = get_settings()
        if settings.render_use_local_dev:
            _render = Render(
                token=settings.render_api_key,
                base_url=settings.render_local_dev_url,
            )
        else:
            _render = Render(token=settings.render_api_key)
    return _render


# SSE clients for real-time updates
sse_clients: list[asyncio.Queue] = []


async def broadcast_event(event_type: str, data: dict) -> None:
    """Broadcast an event to all connected SSE clients."""
    message = json.dumps({"type": event_type, "data": data})
    for queue in sse_clients:
        await queue.put(message)


async def health_handler() -> dict:
    """GET /health - Health check endpoint."""
    return {"status": "healthy"}


async def events_handler(request: Request) -> EventSourceResponse:
    """GET /events - SSE endpoint for real-time webhook updates."""
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


async def webhook_handler(
    request: Request,
    x_webhook_signature: str,
    x_webhook_timestamp: str,
) -> WebhookResponse:
    """POST /webhook - Receive and process webhook events."""
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

    # Handle payment.failed - acknowledge but don't trigger workflow
    if event.event_type == "payment.failed":
        logger.info(f"Payment failed for order {event.data.order_id} - skipping workflow")
        return WebhookResponse(
            status="acknowledged",
            event_id=event.event_id,
            task_run_id=None,
            message="Payment failed event acknowledged (no workflow triggered)",
        )

    # Check workflow configuration
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

    # Trigger the Render Workflow task
    try:
        render = get_render_client()
        task_input = [event.model_dump(mode="json")]

        task_name = "process_payment"
        task_identifier = (
            task_name
            if settings.render_use_local_dev
            else f"{settings.workflow_slug}/{task_name}"
        )

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

        await broadcast_event(
            "webhook_received",
            {
                "response": response.model_dump(mode="json"),
                "event": event.model_dump(mode="json"),
            },
        )

        return response

    except Exception as e:
        logger.error(f"Failed to trigger workflow: {e}")
        return WebhookResponse(
            status="accepted",
            event_id=event.event_id,
            task_run_id=None,
            message="Event validated but workflow trigger failed",
        )


async def task_status_handler(task_run_id: str) -> dict:
    """GET /task-status/{task_run_id} - Check workflow task status."""
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

    try:
        render = get_render_client()
        root_task = await render.workflows.get_task_run(task_run_id)

        # Fetch subtasks using low-level API with root_task_run_id filter
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
                    if run.id == task_run_id:
                        continue
                    subtasks.append(
                        {
                            "task_run_id": run.id,
                            "task_id": run.task_id,
                            "status": (
                                run.status.value
                                if hasattr(run.status, "value")
                                else str(run.status)
                            ),
                        }
                    )
        except Exception as e:
            logger.warning(f"Could not fetch subtasks: {e}")

        return {
            "task_run_id": root_task.id,
            "status": (
                root_task.status.value
                if hasattr(root_task.status, "value")
                else str(root_task.status)
            ),
            "task_id": root_task.task_id if hasattr(root_task, "task_id") else None,
            "retries": root_task.retries if hasattr(root_task, "retries") else None,
            "results": root_task.results if hasattr(root_task, "results") else None,
            "subtasks": subtasks,
        }

    except Exception as e:
        logger.error(f"Failed to get task status: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve task status",
        )
