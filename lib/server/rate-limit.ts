import { createHmac, timingSafeEqual } from "node:crypto";

export type HeaderSource = { get(name: string): string | null };

/** Proxy signs the exact UTF-8 payload `${operation}:${identity}` with HMAC-SHA256 hex. */
export function trustedRateLimitIdentity(headers: HeaderSource, operation: string, env: { OPEN_TAB_TRUSTED_PROXY_IP_HEADER?: string; OPEN_TAB_TRUSTED_PROXY_SIGNATURE_HEADER?: string; OPEN_TAB_TRUSTED_PROXY_HMAC_SECRET?: string } = process.env as any): string {
  const identity = env.OPEN_TAB_TRUSTED_PROXY_IP_HEADER ? headers.get(env.OPEN_TAB_TRUSTED_PROXY_IP_HEADER) : null;
  const signature = env.OPEN_TAB_TRUSTED_PROXY_SIGNATURE_HEADER ? headers.get(env.OPEN_TAB_TRUSTED_PROXY_SIGNATURE_HEADER) : null;
  const secret = env.OPEN_TAB_TRUSTED_PROXY_HMAC_SECRET;
  if (!identity || !signature || !secret || secret.length < 32) return "global";
  const expected = createHmac("sha256", secret).update(`${operation}:${identity}`, "utf8").digest("hex");
  const actual = Buffer.from(signature, "hex"); const wanted = Buffer.from(expected, "hex");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted) ? identity : "global";
}
