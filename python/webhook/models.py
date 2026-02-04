"""Pydantic models for webhook payload validation."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class PaymentData(BaseModel):
    """Payment details from the payment provider."""

    payment_id: str = Field(..., description="Unique payment identifier (e.g., pi_abc123)")
    amount: int = Field(..., gt=0, description="Amount in cents")
    currency: str = Field(..., pattern="^[a-z]{3}$", description="ISO 4217 currency code")
    customer_email: str = Field(..., description="Customer email address")
    customer_name: str = Field(..., description="Customer full name")
    order_id: str = Field(..., description="Reference to the associated order")
    metadata: dict[str, str] = Field(default_factory=dict, description="Additional context")


class WebhookEvent(BaseModel):
    """Webhook event payload structure."""

    event_type: Literal["payment.succeeded", "payment.failed"] = Field(
        ..., description="Type of event"
    )
    event_id: str = Field(..., description="Unique event ID for idempotency")
    timestamp: datetime = Field(..., description="When the event occurred")
    data: PaymentData = Field(..., description="Event-specific payload")


class WebhookResponse(BaseModel):
    """Response returned by the webhook endpoint."""

    status: str = Field(..., description="Processing status")
    event_id: str = Field(..., description="Echo of the received event ID")
    task_run_id: str | None = Field(None, description="Workflow task run ID if triggered")
    message: str = Field(..., description="Human-readable status message")
