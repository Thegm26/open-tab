import { NextRequest } from "next/server";
import { error, json, owner } from "@/lib/server/http";
import { store } from "@/lib/server/store";
export async function GET(request: NextRequest, { params }: { params: Promise<{ orderId: string }> }) {
  try { const { orderId } = await params; const order = await store.getOrder(orderId); await owner(request, order.scenarioId); const scenario = await store.getScenario(order.scenarioId); return json({ order: await store.getOrder(orderId), pool: { availableCents: await store.availablePoolCents(order.scenarioId), settledCents: scenario.settledPoolCents } }); } catch (cause) { return error(cause); }
}
