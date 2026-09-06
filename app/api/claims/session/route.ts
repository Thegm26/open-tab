import { NextRequest } from "next/server";
import { claimAuthority, error, json } from "@/lib/server/http";
import { store } from "@/lib/server/store";
export async function GET(_request: NextRequest) {
  try { const { claimId } = await claimAuthority(); const claim = await store.getClaim(claimId); const order = await store.getOrder(claim.orderId); return json({ claim: { id: claim.id, expiresAt: claim.expiresAt, consumed: Boolean(claim.consumedAt), expired: claim.expiresAt <= new Date() }, order }); } catch (cause) { return error(cause); }
}
