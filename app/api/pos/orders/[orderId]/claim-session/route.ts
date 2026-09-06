import { NextRequest } from "next/server";
import { error, json, key, owner } from "@/lib/server/http";
import { store } from "@/lib/server/store";
export async function POST(request: NextRequest, { params }: { params: Promise<{ orderId: string }> }) {
  try { const { orderId } = await params; const order = await store.getOrder(orderId); await owner(request, order.scenarioId, true); const claim = await store.createClaim({ orderId, idempotencyKey: key(request) }); return json({ ...claim, claimUrl: `/claim#${claim.token}` }); } catch (cause) { return error(cause); }
}
