import { NextRequest } from "next/server";
import { error, json, key, owner } from "@/lib/server/http";
import { store } from "@/lib/server/store";

/** Complete a normal checkout without collecting a round-up contribution. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    const { orderId } = await params;
    const order = await store.getOrder(orderId);
    await owner(request, order.scenarioId, true);
    const body = await request.json().catch(() => ({})) as { succeeded?: unknown };
    return json(await store.settleRoundup({ orderId, processorSucceeded: body.succeeded !== false, acceptRoundup: false, idempotencyKey: key(request) }));
  } catch (cause) { return error(cause); }
}
