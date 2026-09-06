import { NextRequest } from "next/server";
import { error, json, key, owner } from "@/lib/server/http";
import { store } from "@/lib/server/store";

export async function POST(request: NextRequest, { params }: { params: Promise<{ receivableId: string }> }) {
  try { const { receivableId } = await params; const receivable = (await store.listReceivables((request.nextUrl.searchParams.get("scenarioId") ?? ""))).find((entry: any) => entry.id === receivableId); if (!receivable) throw new Error("RECEIVABLE_NOT_FOUND"); await owner(request, receivable.scenarioId, true); return json(await store.settleReceivable({ receivableId, idempotencyKey: key(request) })); } catch (cause) { return error(cause); }
}
