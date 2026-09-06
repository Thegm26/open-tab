import { NextRequest } from "next/server";
import { deviceCredential, error, installClaim, installDevice, json, rateLimit } from "@/lib/server/http";
import { store } from "@/lib/server/store";

/** The fragment token is accepted only in this no-store body and never appears in a URL. */
export async function POST(request: NextRequest) {
  try {
    await rateLimit(request, "claim-exchange", 20, 60_000);
    const { token } = await request.json() as { token?: unknown };
    if (typeof token !== "string" || token.length < 32) throw new Error("INVALID_CLAIM_TOKEN");
    const claim = await store.exchangeClaimToken(token);
    const device = await deviceCredential();
    const response = json({ status: "EXCHANGED" });
    installClaim(response, claim.id, claim.claimSessionExpiresAt!.getTime(), device.id);
    if (device.cookie) installDevice(response, device.cookie);
    return response;
  } catch (cause) { return error(cause); }
}
