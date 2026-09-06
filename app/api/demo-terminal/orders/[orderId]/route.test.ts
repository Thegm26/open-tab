import { describe, expect, it, vi } from "vitest";

const { completeOrder, requireTerminalOrder } = vi.hoisted(() => ({
  completeOrder: vi.fn(),
  requireTerminalOrder: vi.fn(),
}));

vi.mock("@/lib/server/demo-terminal", () => ({ requireTerminalOrder }));
vi.mock("@/lib/server/store", () => ({ store: { completeOrder } }));
vi.mock("@/lib/server/http", () => ({
  error: (cause: unknown) => new Response(JSON.stringify({ error: String(cause) }), { status: 500 }),
  json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status }),
  key: (request: Request) => request.headers.get("idempotency-key") ?? "",
}));

import { POST } from "./route";

describe("demo terminal order actions", () => {
  it("completes an authorized order without employee owner authorization", async () => {
    const order = { id: "order-1", scenarioId: "scenario-1" };
    requireTerminalOrder.mockResolvedValue(order);
    completeOrder.mockResolvedValue({ status: "COMPLETED", openTabCents: 60 });

    const request = new Request("http://localhost/api/demo-terminal/orders/order-1", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "payment-1" },
      body: JSON.stringify({ action: "complete" }),
    });
    const response = await POST(request as never, { params: Promise.resolve({ orderId: order.id }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "COMPLETED", openTabCents: 60 });
    expect(completeOrder).toHaveBeenCalledWith({ orderId: order.id, idempotencyKey: "payment-1" });
  });
});
