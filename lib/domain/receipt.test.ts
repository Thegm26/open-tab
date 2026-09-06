import { describe, expect, it } from "vitest";
import { receiptSummary } from "./receipt";

describe("receipt summary", () => {
  it("shows assistance as covered by Open Tab, never as a contribution", () => {
    expect(receiptSummary({ totalCents: 280, openTabCents: 30, customerTenderCents: 250 }, "assisted", 30)).toMatchObject({ paidCents: 250, purchaseCents: 280, contributionCents: 0, assistanceCents: 30, customerPaidCents: 250 });
  });
  it("shows exact payment without a contribution", () => {
    expect(receiptSummary({ totalCents: 280, openTabCents: 0, customerTenderCents: 280 }, "exact", 20)).toMatchObject({ paidCents: 280, purchaseCents: 280, contributionCents: 0, assistanceCents: 0 });
  });
  it("adds only a real round-up contribution to customer paid", () => {
    expect(receiptSummary({ totalCents: 280, openTabCents: 0, customerTenderCents: 280 }, "roundup", 20)).toMatchObject({ paidCents: 300, purchaseCents: 280, contributionCents: 20, assistanceCents: 0 });
  });
});
