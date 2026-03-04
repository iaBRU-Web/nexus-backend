/**
 * lib/auth.js — HMAC-SHA256 token verification (Node.js side)
 * Tokens issued by Go, verified here.
 *
 * BUG FIX #1: removed `if (data.length !== data.length)` — was always false (same var both sides)
 */

import crypto from "crypto";

const SECRET = process.env.TOKEN_SECRET || "nexus_fallback_secret_set_in_vercel";

export function verifyToken(token) {
  try {
    if (!token || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [data, sig] = parts;

    const expected = crypto
      .createHmac("sha256", SECRET)
      .update(data)
      .digest("base64url");

    // BUG FIX #1: compare sig vs expected (not data vs data)
    const sigBuf      = Buffer.from(sig,      "base64url");
    const expectedBuf = Buffer.from(expected,  "base64url");
    if (sigBuf.length !== expectedBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

    return JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function authFromHeader(authHeader) {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return verifyToken(authHeader.slice(7));
}
