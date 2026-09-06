import { createHmac, randomBytes } from "node:crypto";

const developmentSecret = "local-development-secret-change-me-32b";

function secret(): string {
  const configured = process.env.OPEN_TAB_CREDENTIAL_SECRET;
  if (configured && configured.length >= 32) return configured;
  if (process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development") return developmentSecret;
  throw new Error("OPEN_TAB_CREDENTIAL_SECRET must be at least 32 bytes outside test/development");
}

function derive(namespace: string, context: string): string {
  return createHmac("sha256", secret()).update(`${namespace}:v1:${context}`).digest("base64url");
}

export function createOpaqueToken(): string { return randomBytes(32).toString("base64url"); }
export function hashToken(token: string): string { return createHmac("sha256", secret()).update(`hash:${token}`).digest("hex"); }
export function deriveClaimToken(scenarioId: string, claimId: string, generation: number): string { return derive("claim", `${scenarioId}:${claimId}:${generation}`); }
export function deriveOwnerToken(scenarioId: string): string { return derive("owner", scenarioId); }
/** A claim-session cookie is narrower than the QR bearer credential. */
export function deriveClaimSessionToken(claimId: string, expiresAt: number, deviceId = ""): string { return derive("claim-session", `${claimId}:${expiresAt}:${deviceId}`); }
export function deriveDeviceSessionToken(deviceId: string): string { return derive("device-session", deviceId); }
/** Double-submit token. It is bound to a scenario but is never an authority by itself. */
export function deriveCsrfToken(scenarioId: string): string { return derive("csrf", scenarioId); }
