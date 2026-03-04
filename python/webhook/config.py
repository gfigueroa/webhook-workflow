"""Environment configuration for the webhook service."""

import os
from functools import lru_cache

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # Webhook security
    webhook_secret: str = "demo-webhook-secret"

    # Render Workflows
    render_api_key: str = ""
    # Workflow slug (the service name on Render)
    # The code automatically appends the task name for production
    workflow_slug: str = ""

    # Local development (set RENDER_USE_LOCAL_DEV=true to use local task server)
    # See: https://render.com/docs/workflows-local-development
    render_use_local_dev: bool = False
    render_local_dev_url: str = "http://localhost:8120"

    # Server settings
    host: str = "0.0.0.0"
    port: int = 10000

    # Security settings
    timestamp_tolerance_seconds: int = 300  # 5 minutes

    # Demo mode (enables rate limiting on /webhook)
    demo_mode: bool = False

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
