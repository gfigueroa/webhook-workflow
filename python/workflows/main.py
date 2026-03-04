"""Render Workflow tasks for payment processing.

This module defines workflow tasks that process payment events asynchronously.
Tasks demonstrate parallel execution, sequential chaining, and retry logic.
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from render_sdk import Retry, Workflows

# Configure logging
logging.basicConfig(level=logging.WARNING)
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

app = Workflows(
    default_retry=Retry(max_retries=3, wait_duration_ms=1000, backoff_scaling=2.0),
    default_timeout=300,
)


@app.task
async def update_records(payment_id: str, order_id: str, amount: int, currency: str) -> dict:
    """
    Update order records to mark payment as complete.

    In a real application, this would:
    - Update the order status in the database
    - Record the payment transaction
    - Update inventory reservations

    Args:
        payment_id: Unique payment identifier
        order_id: Associated order identifier
        amount: Payment amount in cents
        currency: ISO currency code

    Returns:
        Dict with update status and details
    """
    logger.info(f"Updating records for order {order_id} (payment: {payment_id})")

    # Simulate database operations
    await asyncio.sleep(0.5)

    result = {
        "task": "update_records",
        "payment_id": payment_id,
        "order_id": order_id,
        "amount": amount,
        "currency": currency,
        "status": "paid",
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }

    logger.info(f"Records updated for order {order_id}")
    return result


@app.task
async def send_receipt(
    payment_id: str,
    customer_email: str,
    customer_name: str,
    amount: int,
    currency: str,
    order_id: str,
) -> dict:
    """
    Generate and send a receipt email to the customer.

    In a real application, this would:
    - Generate a formatted receipt
    - Send via email service (SendGrid, SES, etc.)
    - Store a copy for records

    Args:
        payment_id: Unique payment identifier
        customer_email: Customer's email address
        customer_name: Customer's full name
        amount: Payment amount in cents
        currency: ISO currency code
        order_id: Associated order identifier

    Returns:
        Dict with receipt details and send status
    """
    logger.info(f"Sending receipt to {customer_email} for payment {payment_id}")

    # Format amount for display
    amount_formatted = f"${amount / 100:.2f} {currency.upper()}"

    # Simulate email generation and sending
    await asyncio.sleep(0.3)

    receipt = {
        "task": "send_receipt",
        "to": customer_email,
        "customer_name": customer_name,
        "subject": f"Payment Receipt - {amount_formatted}",
        "amount_formatted": amount_formatted,
        "payment_id": payment_id,
        "order_id": order_id,
        "sent_at": datetime.now(timezone.utc).isoformat(),
        "status": "sent",
    }

    logger.info(f"Receipt sent to {customer_email}")
    return receipt


@app.task
async def notify_fulfillment(
    order_id: str,
    payment_id: str,
    customer_name: str,
    metadata: dict[str, str],
) -> dict:
    """
    Notify the fulfillment system to begin order processing.

    This task has retry logic configured to handle transient failures
    when communicating with external fulfillment systems.

    In a real application, this would:
    - Call the fulfillment/warehouse API
    - Create shipping labels
    - Update tracking information

    Args:
        order_id: Order to fulfill
        payment_id: Associated payment
        customer_name: Customer's name for shipping
        metadata: Additional order metadata

    Returns:
        Dict with fulfillment notification status
    """
    logger.info(f"Notifying fulfillment system for order {order_id}")

    # Simulate calling external fulfillment API
    await asyncio.sleep(0.4)

    # Determine priority based on metadata
    priority = "express" if metadata.get("plan") == "pro" else "standard"

    fulfillment = {
        "task": "notify_fulfillment",
        "order_id": order_id,
        "payment_id": payment_id,
        "customer_name": customer_name,
        "priority": priority,
        "notified_at": datetime.now(timezone.utc).isoformat(),
        "status": "notified",
    }

    logger.info(f"Fulfillment notified for order {order_id} (priority: {priority})")
    return fulfillment


@app.task
async def process_payment(event: dict[str, Any]) -> dict:
    """
    Root task that orchestrates payment processing.

    This task:
    1. Extracts payment data from the event
    2. Runs update_records and send_receipt in parallel
    3. After both complete, notifies the fulfillment system

    Args:
        event: The full webhook event payload

    Returns:
        Dict with complete processing results from all subtasks
    """
    event_id = event["event_id"]
    event_type = event["event_type"]
    data = event["data"]

    logger.info(f"Processing payment event {event_id} (type: {event_type})")

    payment_id = data["payment_id"]
    order_id = data["order_id"]
    amount = data["amount"]
    currency = data["currency"]
    customer_email = data["customer_email"]
    customer_name = data["customer_name"]
    metadata = data.get("metadata", {})

    # Run update_records and send_receipt in parallel
    logger.info("Starting parallel tasks: update_records, send_receipt")

    records_result, receipt_result = await asyncio.gather(
        update_records(payment_id, order_id, amount, currency),
        send_receipt(payment_id, customer_email, customer_name, amount, currency, order_id),
    )

    logger.info("Parallel tasks completed, notifying fulfillment")

    # After parallel tasks complete, notify fulfillment
    fulfillment_result = await notify_fulfillment(
        order_id, payment_id, customer_name, metadata
    )

    # Compile final result
    result = {
        "payment_id": payment_id,
        "order_id": order_id,
        "event_id": event_id,
        "status": "succeeded",
        "actions": {
            "records_updated": records_result["status"] == "paid",
            "receipt_sent": receipt_result["status"] == "sent",
            "fulfillment_notified": fulfillment_result["status"] == "notified",
        },
        "records": records_result,
        "receipt": receipt_result,
        "fulfillment": fulfillment_result,
    }

    logger.info(f"Payment processing completed for event {event_id}")
    return result


if __name__ == "__main__":
    app.start()
