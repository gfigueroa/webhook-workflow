"""Webhook service entry point.

Configures FastAPI app, middleware, static files, and routes.
"""

import logging
import time
from collections import defaultdict
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Header, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware

from config import get_settings
from handlers import (
    events_handler,
    health_handler,
    task_status_handler,
    webhook_handler,
)
from models import WebhookResponse

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
        logger.info(
            f"Local dev mode enabled - using task server at {settings.render_local_dev_url}"
        )

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


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Simple in-memory rate limiter for demo mode. Limits POST /webhook to 10 req/min per IP."""

    def __init__(self, app, max_requests: int = 10, window_seconds: int = 60):
        super().__init__(app)
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self.requests: dict[str, list[float]] = defaultdict(list)

    async def dispatch(self, request: Request, call_next):
        if request.method != "POST" or request.url.path != "/webhook":
            return await call_next(request)

        client_ip = request.client.host if request.client else "unknown"
        now = time.time()
        cutoff = now - self.window_seconds
        self.requests[client_ip] = [t for t in self.requests[client_ip] if t > cutoff]

        if len(self.requests[client_ip]) >= self.max_requests:
            return JSONResponse(
                status_code=429,
                content={"detail": "Rate limit exceeded. Try again later."},
            )

        self.requests[client_ip].append(now)
        return await call_next(request)


app = FastAPI(
    title="Webhook Demo with Render Workflows",
    description="Securely receive webhooks with HMAC signature validation and trigger async tasks",
    version="1.0.0",
    lifespan=lifespan,
)

settings = get_settings()
if settings.demo_mode:
    app.add_middleware(RateLimitMiddleware)
    logger.info("Demo mode enabled - rate limiting active on /webhook")

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


# Routes
@app.get("/")
async def root():
    """Serve the webhook tester UI."""
    if static_dir.exists():
        index_path = static_dir / "index.html"
        if index_path.exists():
            return FileResponse(index_path)
    return {
        "message": "Webhook service running. POST to /webhook to trigger workflows. "
        "Build frontend with: cd frontend && npm run build"
    }


@app.get("/health")
async def health():
    """Health check endpoint."""
    return await health_handler()


@app.get("/events")
async def events(request: Request):
    """SSE endpoint for real-time webhook updates."""
    return await events_handler(request)


@app.post("/webhook", response_model=WebhookResponse)
async def webhook(
    request: Request,
    x_webhook_signature: str = Header(..., description="HMAC-SHA256 signature"),
    x_webhook_timestamp: str = Header(..., description="Unix timestamp of request"),
) -> WebhookResponse:
    """Receive and process webhook events."""
    return await webhook_handler(request, x_webhook_signature, x_webhook_timestamp)


@app.get("/task-status/{task_run_id}")
async def task_status(task_run_id: str) -> dict:
    """Check the status of a workflow task run."""
    return await task_status_handler(task_run_id)


if __name__ == "__main__":
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "main:app",
        host=settings.host,
        port=settings.port,
        reload=True,
    )
