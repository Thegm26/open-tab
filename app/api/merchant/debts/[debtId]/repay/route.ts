import { NextRequest } from "next/server";
import { error, json, key, owner } from "@/lib/server/http";
import { store } from "@/lib/server/store";

export async function POST(request: NextRequest, { params }: { params: Promise<{ debtId: string }> }) {
  try { const { debtId } = await params; const scenarioId = request.nextUrl.searchParams.get("scenarioId") ?? ""; const debt = (await store.listDebts(scenarioId)).find((entry: any) => entry.id === debtId); if (!debt) throw new Error("DEBT_NOT_FOUND"); await owner(request, debt.scenarioId, true); const body = await request.json() as { amountCents?: number }; return json(await store.repayDebt({ debtId, amountCents: body.amountCents ?? 0, idempotencyKey: key(request) })); } catch (cause) { return error(cause); }
}
