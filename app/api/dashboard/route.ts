import { NextRequest } from "next/server";
import { error, json, owner } from "@/lib/server/http";
import { store } from "@/lib/server/store";

/** Owner-only aggregate used by the merchant demo surface. It deliberately reads
 * through the store adapter so local and Supabase demos expose the same shape. */
export async function GET(request: NextRequest) {
  try {
    const scenarioId = request.nextUrl.searchParams.get("scenarioId") ?? "";
    if (!scenarioId) throw new Error("SCENARIO_NOT_FOUND");
    await owner(request, scenarioId);
    const scenario = await store.getScenario(scenarioId);
    const [ledger, receivables, debts] = await Promise.all([
      store.listLedger(scenarioId),
      store.listReceivables(scenarioId),
      store.listDebts(scenarioId),
    ]);
    const contributedCents = ledger.filter((entry: any) => entry.kind === "roundup_credit").reduce((sum: number, entry: any) => sum + entry.amountCents, 0);
    const completedHelpedCount = receivables.filter((entry: any) => entry.status !== "fully_reversed").length;
    return json({
      scenario,
      pool: { availableCents: await store.availablePoolCents(scenarioId), settledCents: scenario.settledPoolCents },
      contributedCents,
      completedHelpedCount,
      ledger,
      receivables,
      debts,
    });
  } catch (cause) { return error(cause); }
}
