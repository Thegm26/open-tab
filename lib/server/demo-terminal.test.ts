import { describe, expect, it, vi } from "vitest";

const orders = new Map<string, any>();
vi.mock("./store", () => ({ store: { getOrder: (id: string) => orders.get(id) } }));

import { publishTerminalOrder, requireTerminalOrder, terminalOrder } from "./demo-terminal";
import type { Order } from "../domain/types";

const order = (id: string, createdAt: string): Order => ({
  id, scenarioId: "scenario", merchantId: "cafe", totalCents: 280,
  openTabCents: 0, customerTenderCents: 280, remainingTenderCents: 280,
  status: "open", refundableCents: 280, refundedCents: 0,
  customerRefundedCents: 0, poolRefundedCents: 0, createdAt: new Date(createdAt),
});

describe("demo terminal current order", () => {
  it("returns the newest published order and rejects an older lane", async () => {
    const first = order("first", "2026-09-07T10:00:00Z");
    const second = order("second", "2026-09-07T10:01:00Z");
    orders.set(first.id, first); orders.set(second.id, second);
    publishTerminalOrder(first);
    expect((await terminalOrder())?.id).toBe("first");
    publishTerminalOrder(second);
    expect((await terminalOrder())?.id).toBe("second");
    await expect(requireTerminalOrder("first")).rejects.toMatchObject({ code: "TERMINAL_ORDER_NOT_FOUND" });
    await expect(requireTerminalOrder("second")).resolves.toMatchObject({ status: "open" });
  });
});
