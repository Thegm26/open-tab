import { DomainError, type Order } from "../domain/types";
import { store } from "./store";

/**
 * Single-lane hackathon terminal. This deliberately exposes only the newest
 * published order; normal claim/security routes remain unchanged.
 */
declare global {
  // Shared across Next route bundles in the single demo server process.
  var openTabDemoTerminal: { orderId: string; scenarioId: string; createdAt: number } | undefined;
}
export function publishTerminalOrder(order: Order): void {
  globalThis.openTabDemoTerminal = { orderId: order.id, scenarioId: order.scenarioId, createdAt: order.createdAt.getTime() };
}

export async function terminalOrder(): Promise<Order | undefined> {
  const current = globalThis.openTabDemoTerminal;
  // Always prefer durable state. A warm Vercel instance can retain an older
  // process-local pointer after another instance publishes a newer order.
  try {
    const order = await store.latestOrder();
    if (order) return await store.getOrder(order.id);
  } catch {
    // Fall back to the process-local pointer during a transient store failure.
  }
  if (!current) return undefined;
  try {
    const order = await store.getOrder(current.orderId);
    if (order.scenarioId !== current.scenarioId) return undefined;
    return order;
  } catch {
    return undefined;
  }
}

export async function requireTerminalOrder(orderId: string): Promise<Order> {
  const order = await terminalOrder();
  if (!order || order.id !== orderId) throw new DomainError("TERMINAL_ORDER_NOT_FOUND");
  return order;
}
