"""Webhook signature validation utilities.

Implements HMAC-SHA256 signature verification with replay attack protection.
"""

import hashlib
import hmac
import time


class SignatureVerificationError(Exception):
    """Raised when webhook signature verification fails."""

    pass


class TimestampValidationError(Exception):
    """Raised when the webhook timestamp is too old or in the future."""

    pass


def verify_timestamp(timestamp: str, tolerance_seconds: int = 300) -> None:
    """
    Verify that the timestamp is within acceptable bounds.

    Prevents replay attacks by rejecting requests with timestamps
    that are too old or too far in the future.

    Args:
        timestamp: Unix timestamp as a string
        tolerance_seconds: Maximum allowed difference from current time (default: 5 minutes)

    Raises:
        TimestampValidationError: If timestamp is invalid or outside tolerance
    """
    try:
        request_time = int(timestamp)
    except (ValueError, TypeError) as e:
        raise TimestampValidationError(f"Invalid timestamp format: {timestamp}") from e

    current_time = int(time.time())
    time_difference = abs(current_time - request_time)

    if time_difference > tolerance_seconds:
        raise TimestampValidationError(
            f"Timestamp outside tolerance window. "
            f"Difference: {time_difference}s, Tolerance: {tolerance_seconds}s"
        )


def compute_signature(payload: bytes, timestamp: str, secret: str) -> str:
    """
    Compute the expected HMAC-SHA256 signature for a payload.

    The signature is computed over: timestamp + "." + payload
    This binds the timestamp to the payload, preventing timestamp manipulation.

    Args:
        payload: Raw request body bytes
        timestamp: Unix timestamp string
        secret: Shared secret key

    Returns:
        Hex-encoded HMAC-SHA256 signature
    """
    import logging
    logger = logging.getLogger(__name__)
    
    message = f"{timestamp}.".encode() + payload
    logger.info(f"Signing message (first 100): {message[:100]}")
    
    signature = hmac.new(
        key=secret.encode(),
        msg=message,
        digestmod=hashlib.sha256,
    ).hexdigest()
    return signature


def verify_signature(
    payload: bytes,
    signature_header: str,
    timestamp: str,
    secret: str,
    tolerance_seconds: int = 300,
) -> None:
    """
    Verify the webhook signature and timestamp.

    This function:
    1. Validates the timestamp is within acceptable bounds (replay protection)
    2. Computes the expected signature
    3. Compares signatures using constant-time comparison (timing attack protection)

    Args:
        payload: Raw request body bytes
        signature_header: Value of X-Webhook-Signature header (format: "sha256=<hex>")
        timestamp: Value of X-Webhook-Timestamp header
        secret: Shared secret key for HMAC computation
        tolerance_seconds: Maximum allowed timestamp difference

    Raises:
        TimestampValidationError: If timestamp is invalid or too old
        SignatureVerificationError: If signature is missing, malformed, or invalid
    """
    import logging
    logger = logging.getLogger(__name__)
    
    # Step 1: Validate timestamp (prevents replay attacks)
    verify_timestamp(timestamp, tolerance_seconds)

    # Step 2: Parse the signature header
    if not signature_header:
        raise SignatureVerificationError("Missing signature header")

    # Expected format: "sha256=<hex_signature>"
    if not signature_header.startswith("sha256="):
        raise SignatureVerificationError(
            "Invalid signature format. Expected: sha256=<signature>"
        )

    received_signature = signature_header[7:]  # Remove "sha256=" prefix

    # Step 3: Compute expected signature
    expected_signature = compute_signature(payload, timestamp, secret)

    # Debug logging
    logger.info(f"Timestamp: {timestamp}")
    logger.info(f"Payload length: {len(payload)}, first 100 bytes: {payload[:100]}")
    logger.info(f"Expected sig: {expected_signature[:20]}...")
    logger.info(f"Received sig: {received_signature[:20]}...")

    # Step 4: Constant-time comparison (prevents timing attacks)
    if not hmac.compare_digest(expected_signature, received_signature):
        raise SignatureVerificationError("Invalid signature")
