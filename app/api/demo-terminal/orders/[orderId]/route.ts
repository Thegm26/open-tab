import { NextRequest } from "next/server";
import { error, json, key } from "@/lib/server/http";
import { requireTerminalOrder } from "@/lib/server/demo-terminal";
import { store } from "@/lib/server/store";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    const { orderId } = await params;
    const order = await requireTerminalOrder(orderId);
    return json({ order: await store.getOrder(order.id) });
  } catch (cause) { return error(cause); }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    const { orderId } = await params;
    const order = await requireTerminalOrder(orderId);
    const body = await request.json().catch(() => ({})) as { action?: string; succeeded?: unknown; acceptRoundup?: boolean };
    if (body.action === "claim-session") {
      return json(await store.createClaim({ orderId: order.id, idempotencyKey: key(request) }));
    }
    if (body.action === "checkout" || body.action === "round-up") {
      return json(await store.settleRoundup({
        orderId: order.id,
        processorSucceeded: body.succeeded !== false,
        acceptRoundup: body.action === "round-up" && body.acceptRoundup === true,
        idempotencyKey: key(request),
      }));
    }
    if (body.action === "complete") {
      return json(await store.completeOrder({ orderId: order.id, idempotencyKey: key(request) }));
    }
    return json({ error: "INVALID_TERMINAL_ACTION" }, 400);
  } catch (cause) { return error(cause); }
}
