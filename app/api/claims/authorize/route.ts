import { NextRequest } from "next/server";
import { claimAuthority, deviceCredential, error, installDevice, json, key, rateLimit, validOrigin } from "@/lib/server/http";
import { store } from "@/lib/server/store";
export async function POST(request: NextRequest) {
  try {
    if (!validOrigin(request)) throw new Error("CSRF_REJECTED");
    await rateLimit(request, "redemption", 20, 60_000);
    const { amountCents } = await request.json() as { amountCents?: unknown };
    if (!Number.isSafeInteger(amountCents)) throw new Error("INVALID_ASSISTANCE_AMOUNT");
    const { claimId } = await claimAuthority();
    const device = await deviceCredential({ create: false });
    const result = await store.authorizeClaim({ claimId, amountCents: amountCents as number, deviceHash: device.hash, idempotencyKey: key(request) });
    const response = json(result); if (device.cookie) installDevice(response, device.cookie); return response;
  } catch (cause) { return error(cause); }
}
