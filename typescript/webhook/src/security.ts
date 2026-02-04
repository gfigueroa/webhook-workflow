/**
 * Webhook signature validation utilities.
 * Implements HMAC-SHA256 signature verification with replay attack protection.
 */

import crypto from "node:crypto";

export class SignatureVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureVerificationError";
  }
}

export class TimestampValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimestampValidationError";
  }
}

/**
 * Verify that the timestamp is within acceptable bounds.
 *
 * Prevents replay attacks by rejecting requests with timestamps
 * that are too old or too far in the future.
 *
 * @param timestamp - Unix timestamp as a string
 * @param toleranceSeconds - Maximum allowed difference from current time (default: 5 minutes)
 * @throws TimestampValidationError if timestamp is invalid or outside tolerance
 */
export function verifyTimestamp(timestamp: string, toleranceSeconds = 300): void {
  const requestTime = parseInt(timestamp, 10);

  if (isNaN(requestTime)) {
    throw new TimestampValidationError(`Invalid timestamp format: ${timestamp}`);
  }

  const currentTime = Math.floor(Date.now() / 1000);
  const timeDifference = Math.abs(currentTime - requestTime);

  if (timeDifference > toleranceSeconds) {
    throw new TimestampValidationError(
      `Timestamp outside tolerance window. Difference: ${timeDifference}s, Tolerance: ${toleranceSeconds}s`
    );
  }
}

/**
 * Compute the expected HMAC-SHA256 signature for a payload.
 *
 * The signature is computed over: timestamp + "." + payload
 * This binds the timestamp to the payload, preventing timestamp manipulation.
 *
 * @param payload - Raw request body as Buffer
 * @param timestamp - Unix timestamp string
 * @param secret - Shared secret key
 * @returns Hex-encoded HMAC-SHA256 signature
 */
export function computeSignature(
  payload: Buffer,
  timestamp: string,
  secret: string
): string {
  const message = Buffer.concat([Buffer.from(`${timestamp}.`), payload]);

  console.log(`Signing message (first 100): ${message.subarray(0, 100).toString()}`);

  const signature = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("hex");

  return signature;
}

/**
 * Verify the webhook signature and timestamp.
 *
 * This function:
 * 1. Validates the timestamp is within acceptable bounds (replay protection)
 * 2. Computes the expected signature
 * 3. Compares signatures using constant-time comparison (timing attack protection)
 *
 * @param payload - Raw request body as Buffer
 * @param signatureHeader - Value of X-Webhook-Signature header (format: "sha256=<hex>")
 * @param timestamp - Value of X-Webhook-Timestamp header
 * @param secret - Shared secret key for HMAC computation
 * @param toleranceSeconds - Maximum allowed timestamp difference
 * @throws TimestampValidationError if timestamp is invalid or too old
 * @throws SignatureVerificationError if signature is missing, malformed, or invalid
 */
export function verifySignature(
  payload: Buffer,
  signatureHeader: string,
  timestamp: string,
  secret: string,
  toleranceSeconds = 300
): void {
  // Step 1: Validate timestamp (prevents replay attacks)
  verifyTimestamp(timestamp, toleranceSeconds);

  // Step 2: Parse the signature header
  if (!signatureHeader) {
    throw new SignatureVerificationError("Missing signature header");
  }

  // Expected format: "sha256=<hex_signature>"
  if (!signatureHeader.startsWith("sha256=")) {
    throw new SignatureVerificationError(
      "Invalid signature format. Expected: sha256=<signature>"
    );
  }

  const receivedSignature = signatureHeader.slice(7); // Remove "sha256=" prefix

  // Step 3: Compute expected signature
  const expectedSignature = computeSignature(payload, timestamp, secret);

  // Debug logging
  console.log(`Timestamp: ${timestamp}`);
  console.log(
    `Payload length: ${payload.length}, first 100 bytes: ${payload.subarray(0, 100).toString()}`
  );
  console.log(`Expected sig: ${expectedSignature.slice(0, 20)}...`);
  console.log(`Received sig: ${receivedSignature.slice(0, 20)}...`);

  // Step 4: Constant-time comparison (prevents timing attacks)
  const expectedBuffer = Buffer.from(expectedSignature, "hex");
  const receivedBuffer = Buffer.from(receivedSignature, "hex");

  if (
    expectedBuffer.length !== receivedBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
  ) {
    throw new SignatureVerificationError("Invalid signature");
  }
}
