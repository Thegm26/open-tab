import { NextRequest } from "next/server";
import { error, json, key, owner } from "@/lib/server/http";
import { store } from "@/lib/server/store";
export async function POST(request: NextRequest, { params }: { params: Promise<{ orderId: string }> }) {
  try { const { orderId } = await params; const order = await store.getOrder(orderId); await owner(request, order.scenarioId, true); const body = await request.json() as { succeeded?: boolean; acceptRoundup?: boolean }; return json(await store.settleRoundup({ orderId, processorSucceeded: body.succeeded === true, acceptRoundup: body.acceptRoundup === true, idempotencyKey: key(request) })); } catch (cause) { return error(cause); }
}
