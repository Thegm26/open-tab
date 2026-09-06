import { NextRequest } from "next/server";
import { canonicalItems, isMerchantSlug, totalForItems } from "@/lib/domain/catalog";
import { error, json, key, owner } from "@/lib/server/http";
import { store } from "@/lib/server/store";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { scenarioId?: string; merchant?: string; items?: unknown; roundupContributionCents?: unknown };
    if (!body.scenarioId || !body.merchant || !isMerchantSlug(body.merchant)) throw new Error("INVALID_ORDER_REQUEST");
    await owner(request, body.scenarioId, true);
    const items = canonicalItems(body.merchant, body.items);
    const totalCents = totalForItems(body.merchant, items);
    const order = await store.createOrder({ scenarioId: body.scenarioId, merchantId: body.merchant, totalCents, roundupContributionCents: body.roundupContributionCents as number | undefined, idempotencyKey: key(request), requestFingerprint: { merchant: body.merchant, items, roundupContributionCents: body.roundupContributionCents ?? 20 } });
    return json({ order });
  } catch (cause) { return error(cause); }
}
