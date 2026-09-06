import type { Order } from "./types";

export type PaymentKind = "exact" | "roundup" | "assisted";
export type ReceiptSummary = { paidCents: number; purchaseCents: number; contributionCents: number; assistanceCents: number; customerPaidCents: number };

/** Build receipt values without conflating a donation with Open Tab assistance. */
export function receiptSummary(order: Pick<Order, "totalCents" | "openTabCents" | "customerTenderCents">, paymentKind: PaymentKind, contributionCents = 0): ReceiptSummary {
  const assistanceCents = Math.max(0, Math.min(order.totalCents, order.openTabCents));
  const customerPaidCents = Math.max(0, Math.min(order.totalCents, order.customerTenderCents));
  const contribution = paymentKind === "roundup" ? Math.max(0, contributionCents) : 0;
  return { paidCents: customerPaidCents + contribution, purchaseCents: order.totalCents, contributionCents: contribution, assistanceCents, customerPaidCents };
}
