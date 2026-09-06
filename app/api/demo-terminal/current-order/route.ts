import { json } from "@/lib/server/http";
import { terminalOrder } from "@/lib/server/demo-terminal";

export async function GET() {
  const order = await terminalOrder();
  return json({ order: order ?? null });
}
