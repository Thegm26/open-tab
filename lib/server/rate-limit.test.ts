import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { trustedRateLimitIdentity } from "./rate-limit";

const env = { OPEN_TAB_TRUSTED_PROXY_IP_HEADER: "x-proxy-id", OPEN_TAB_TRUSTED_PROXY_SIGNATURE_HEADER: "x-proxy-sig", OPEN_TAB_TRUSTED_PROXY_HMAC_SECRET: "s".repeat(32) };
const headers = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? null });
describe("trusted proxy limiter identity", () => {
  it("uses global for unsigned and forged identities", () => {
    expect(trustedRateLimitIdentity(headers({ "x-real-ip": "1.2.3.4", "x-proxy-id": "a" }), "op", env)).toBe("global");
    expect(trustedRateLimitIdentity(headers({ "x-proxy-id": "a", "x-proxy-sig": "00" }), "op", env)).toBe("global");
  });
  it("accepts only a valid canonical HMAC signature", () => {
    const sig = createHmac("sha256", env.OPEN_TAB_TRUSTED_PROXY_HMAC_SECRET).update("op:a").digest("hex");
    expect(trustedRateLimitIdentity(headers({ "x-proxy-id": "a", "x-proxy-sig": sig }), "op", env)).toBe("a");
  });
});
