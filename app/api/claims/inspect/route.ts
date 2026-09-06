import { NextRequest } from "next/server";
import { claimAuthority, error, json, rateLimit } from "@/lib/server/http";
import { CATALOG, isMerchantSlug } from "@/lib/domain/catalog";
import { store } from "@/lib/server/store";
export async function POST(_request: NextRequest) {
  try {
    await rateLimit(_request, "claim-inspect", 30, 60_000);
    const { claimId } = await claimAuthority(); const claim = await store.getClaim(claimId); const order = await store.getOrder(claim.orderId); const scenario = await store.getScenario(claim.scenarioId);
    const merchant = isMerchantSlug(order.merchantId as never) ? CATALOG[order.merchantId as keyof typeof CATALOG].name : "Participating merchant";
    return json({ claim: { expiresAt: claim.expiresAt, expired: claim.expiresAt <= new Date(), used: Boolean(claim.consumedAt) }, order: { totalCents: order.totalCents, remainingTenderCents: order.remainingTenderCents, status: order.status }, merchant, pool: { availableCents: await store.availablePoolCents(scenario.id), activated: scenario.activated }, limits: { perOrderCents: scenario.policy.perOrderLimitCents } });
  } catch (cause) { return error(cause); }
}
