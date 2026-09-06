import { json } from "@/lib/server/http";
import { terminalOrder } from "@/lib/server/demo-terminal";
import { store } from "@/lib/server/store";

export async function GET() {
  const order = await terminalOrder();
  return json({ order: order ?? null, availablePoolCents: order ? store.availablePoolCents(order.scenarioId) : 0 });
}
