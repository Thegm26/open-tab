import { NextRequest } from "next/server";
import { error, json, owner } from "@/lib/server/http";
import { store } from "@/lib/server/store";

export async function GET(request: NextRequest, { params }: { params: Promise<{ scenarioId: string }> }) {
  try { const { scenarioId } = await params; await owner(request, scenarioId); return json({ scenario: await store.getScenario(scenarioId) }); } catch (cause) { return error(cause); }
}
