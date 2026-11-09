import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Token generation and verification. Plaintext never stored. */

export const TOKEN_PREFIX = "umcp_";

/** Generate a fresh token. Returns the plaintext — display once, store only the hash. */
export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** Deterministic hash: sha256(pepper || token). */
export function hashToken(token: string, pepper: string): string {
  return createHash("sha256").update(pepper).update("\x00").update(token).digest("hex");
}

/** Constant-time comparison of two hex digests. */
export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
