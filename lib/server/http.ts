import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { deriveClaimSessionToken, deriveDeviceSessionToken } from "@/lib/domain/credentials";
import { DomainError } from "@/lib/domain/types";
import { store } from "./store";
import { trustedRateLimitIdentity } from "./rate-limit";

const production = process.env.NODE_ENV === "production";
const ownerCookie = (scenarioId: string) => `ot_owner_${scenarioId}`;
const csrfCookie = (scenarioId: string) => `ot_csrf_${scenarioId}`;
const claimCookie = "ot_claim";
const deviceCookie = "ot_device";

export const noStore = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const buckets = new Map<string, { started: number; count: number }>();
/** Proxy contract: identity header contains the client identifier; signature header is
 * hex HMAC-SHA256(secret, `${operation}:${identity}`). Both headers and the secret
 * must be configured server-side. Unsigned/malformed values intentionally become global. */
export async function rateLimit(request: NextRequest, operation: string, limit: number, windowMs: number): Promise<void> {
  const address = trustedRateLimitIdentity(request.headers, operation);
  if (process.env.NODE_ENV === "production" && typeof store.rateLimit === "function") {
    if (!await store.rateLimit(`${operation}:${address}`, limit, windowMs)) throw new DomainError("RATE_LIMITED");
    return;
  }
  const now = Date.now();
  const key = `${operation}:${address}`; const current = buckets.get(key);
  if (!current || now - current.started >= windowMs) { buckets.set(key, { started: now, count: 1 }); return; }
  current.count++;
  if (current.count > limit) throw new DomainError("RATE_LIMITED");
  if (buckets.size > 10_000) for (const [entry, value] of buckets) if (now - value.started >= windowMs) buckets.delete(entry);
}
export function json(body: unknown, status = 200, headers: HeadersInit = {}) { return NextResponse.json(body, { status, headers: { ...noStore, ...headers } }); }
export function error(error: unknown) {
  const code = error instanceof DomainError ? error.code : error instanceof Error ? error.message : "INTERNAL_ERROR";
  const status = code === "RATE_LIMITED" ? 429 : code === "IDEMPOTENCY_CONFLICT" ? 409 : ["ORDER_CLOSED", "CLAIM_USED", "ORDER_COMPLETED_USE_REFUND", "AUTHORIZATION_EXPIRED"].includes(code) ? 409 : ["SCENARIO_NOT_FOUND", "ORDER_NOT_FOUND", "CLAIM_NOT_FOUND"].includes(code) ? 404 : 400;
  return json({ error: code }, status);
}
export function key(request: NextRequest): string { return request.headers.get("idempotency-key") ?? ""; }
export function validOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const parsed = new URL(origin); const expected = request.nextUrl;
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.protocol === expected.protocol && parsed.hostname === expected.hostname && parsed.port === expected.port;
  } catch { return false; }
}
export async function owner(request: NextRequest, scenarioId: string, mutation = false): Promise<void> {
  const jar = await cookies(); const actual = jar.get(ownerCookie(scenarioId))?.value;
  let expected: string;
  try { expected = await store.ownerTokenForScenario(scenarioId); } catch { throw new DomainError("SCENARIO_EXPIRED"); }
  if (!actual || !safeEqual(actual, expected)) throw new DomainError("OWNER_UNAUTHORIZED");
  if (mutation) {
    const csrf = jar.get(csrfCookie(scenarioId))?.value;
    if (!validOrigin(request) || !csrf || !safeEqual(csrf, await store.csrfFor(scenarioId)) || !safeEqual(csrf, request.headers.get("x-csrf-token") ?? "")) throw new DomainError("CSRF_REJECTED");
  }
}
export function installOwner(response: NextResponse, scenarioId: string, ownerToken: string, csrfToken: string) {
  const options = { httpOnly: true, sameSite: "strict" as const, secure: production, path: "/", maxAge: 24 * 60 * 60 };
  response.cookies.set(ownerCookie(scenarioId), ownerToken, options);
  response.cookies.set(csrfCookie(scenarioId), csrfToken, { ...options, httpOnly: false });
}
export async function claimAuthority(): Promise<{ claimId: string }> {
  const value = (await cookies()).get(claimCookie)?.value;
  if (!value) throw new DomainError("CLAIM_UNAUTHORIZED");
  const [claimId, expiresText, signature, deviceId] = value.split("."); const expiresAt = Number(expiresText);
  const deviceValue = (await cookies()).get(deviceCookie)?.value; const currentDeviceId = deviceValue?.split(".")[0];
  const currentDeviceSignature = deviceValue?.split(".")[1];
  if (!claimId || !Number.isSafeInteger(expiresAt) || !signature || !deviceId || !currentDeviceId || !currentDeviceSignature || deviceId !== currentDeviceId || !safeEqual(currentDeviceSignature, deriveDeviceSessionToken(currentDeviceId)) || !safeEqual(signature, deriveClaimSessionToken(claimId, expiresAt, deviceId)) || expiresAt <= Date.now()) throw new DomainError("CLAIM_UNAUTHORIZED");
  const claim = await store.getClaim(claimId);
  if (claim.cancelledAt || claim.consumedAt || claim.expiresAt <= new Date() || !claim.claimSessionExpiresAt || claim.claimSessionExpiresAt.getTime() !== expiresAt) throw new DomainError("CLAIM_EXPIRED");
  return { claimId };
}
export function installClaim(response: NextResponse, claimId: string, expiresAt: number, deviceId: string) {
  response.cookies.set(claimCookie, `${claimId}.${expiresAt}.${deriveClaimSessionToken(claimId, expiresAt, deviceId)}.${deviceId}`, { httpOnly: true, sameSite: "strict", secure: production, path: "/", maxAge: 10 * 60 });
}
export async function deviceCredential(options: { create?: boolean } = {}): Promise<{ hash: string; cookie?: string; id: string }> {
  const jar = await cookies(); let value = jar.get(deviceCookie)?.value;
  let identifier = value?.split(".")[0]; const signature = value?.split(".")[1];
  if (!identifier || !signature || !safeEqual(signature, deriveDeviceSessionToken(identifier))) {
    if (options.create === false) throw new DomainError("DEVICE_UNAUTHORIZED");
    identifier = randomBytes(32).toString("base64url");
    value = `${identifier}.${deriveDeviceSessionToken(identifier)}`;
    return { id: identifier, hash: createHash("sha256").update(identifier).digest("hex"), cookie: value };
  }
  return { id: identifier, hash: createHash("sha256").update(identifier).digest("hex") };
}
export function installDevice(response: NextResponse, value: string) {
  response.cookies.set(deviceCookie, value, { httpOnly: true, sameSite: "strict", secure: production, path: "/", maxAge: 365 * 24 * 60 * 60 });
}
function safeEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
