import { NextRequest } from "next/server";
import { CATALOG, canonicalItems, isMerchantSlug, totalForItems } from "@/lib/domain/catalog";
import { error, json, key, owner } from "@/lib/server/http";
import { store } from "@/lib/server/store";
import { publishTerminalOrder } from "@/lib/server/demo-terminal";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { scenarioId?: string; merchant?: string; items?: unknown };
    if (!body.scenarioId || !body.merchant || !isMerchantSlug(body.merchant)) throw new Error("INVALID_ORDER_REQUEST");
    const merchant = body.merchant;
    await owner(request, body.scenarioId, true);
    const items = canonicalItems(merchant, body.items);
    const totalCents = totalForItems(merchant, items);
    const orderItems = items.map((line) => ({ ...line, name: CATALOG[merchant].items.find((item) => item.sku === line.sku)!.name, priceCents: CATALOG[merchant].items.find((item) => item.sku === line.sku)!.priceCents }));
    const order = await store.createOrder({ scenarioId: body.scenarioId, merchantId: merchant, totalCents, items: orderItems, idempotencyKey: key(request), requestFingerprint: { merchant, items } });
    publishTerminalOrder(order);
    return json({ order });
  } catch (cause) { return error(cause); }
}
