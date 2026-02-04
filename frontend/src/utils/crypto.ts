/**
 * Compute HMAC-SHA256 signature for webhook payload
 */
export async function computeSignature(
  payload: string,
  timestamp: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const message = encoder.encode(`${timestamp}.${payload}`);
  const signature = await crypto.subtle.sign("HMAC", key, message);

  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate a random event ID
 */
export function generateEventId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "evt_";
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Generate a random payment ID
 */
export function generatePaymentId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "pi_";
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Generate a random order ID
 */
export function generateOrderId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "ord_";
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
