import { describe, expect, it, vi } from "vitest";
import { FixedClock } from "./time";
import { roundUpContributionCents } from "./money";
import { DomainError } from "./types";
import { InMemoryOpenTabStore } from "./store";
import { deriveOwnerToken } from "./credentials";

const key = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;

function setup(seedPoolCents = 2_000) {
  const clock = new FixedClock(new Date("2026-09-06T10:00:00.000Z"));
  const store = new InMemoryOpenTabStore(clock);
  const scenario = store.createScenario({ seedPoolCents });
  return { clock, store, scenario };
}

function redemption(store: InMemoryOpenTabStore, scenarioId: string, totalCents: number, amountCents: number, seq: number, deviceHash = "device-a") {
  const order = store.createOrder({ scenarioId, merchantId: "bakery", totalCents, idempotencyKey: key(`${seq}1`) });
  const claim = store.createClaim({ orderId: order.id, idempotencyKey: key(`${seq}2`) });
  const authorization = store.authorize({ token: claim.token, amountCents, deviceHash, idempotencyKey: key(`${seq}3`) });
  return { order, claim, authorization };
}

describe("round-up arithmetic", () => {
  it.each([[450, 20], [470, 30], [500, 20], [530, 20], [280, 20], [1201, 49], [1249, 1]])("rounds %i by %i cents", (total, expected) => {
    expect(roundUpContributionCents(total)).toBe(expected);
  });
});

describe("Open Tab in-memory lifecycle", () => {
  it("credits a successful server-computed contribution and never credits a decline", () => {
    const { store, scenario } = setup();
    const order = store.createOrder({ scenarioId: scenario.id, merchantId: "cafe", totalCents: 450, idempotencyKey: key("11") });
    expect(store.settleRoundup({ orderId: order.id, processorSucceeded: true, idempotencyKey: key("12") })).toEqual({ contributionCents: 20, status: "COMPLETED" });
    expect(store.getScenario(scenario.id).settledPoolCents).toBe(2020);
    const declined = store.createOrder({ scenarioId: scenario.id, merchantId: "cafe", totalCents: 740, idempotencyKey: key("13") });
    store.settleRoundup({ orderId: declined.id, processorSucceeded: false, idempotencyKey: key("14") });
    expect(store.getScenario(scenario.id).settledPoolCents).toBe(2020);
  });

  it("activates once at the threshold and never deactivates when spent down", () => {
    const clock = new FixedClock(new Date("2026-09-06T10:00:00.000Z"));
    const store = new InMemoryOpenTabStore(clock);
    const scenario = store.createScenario({ seedPoolCents: 0, policy: { activationThresholdCents: 20, perOrderLimitCents: 500 } });
    expect(store.getScenario(scenario.id).activated).toBe(false);
    const contribution = store.createOrder({ scenarioId: scenario.id, merchantId: "cafe", totalCents: 450, idempotencyKey: key("151") });
    store.settleRoundup({ orderId: contribution.id, processorSucceeded: true, idempotencyKey: key("152") });
    expect(store.getScenario(scenario.id).activated).toBe(true);
    const { order } = redemption(store, scenario.id, 20, 20, 16);
    expect(store.getOrder(order.id).status).toBe("completed");
    expect(store.getScenario(scenario.id)).toMatchObject({ settledPoolCents: 0, activated: true });
  });

  it("reserves without debiting, then completes exactly once", () => {
    const { store, scenario } = setup();
    const { order, authorization } = redemption(store, scenario.id, 450, 100, 2);
    expect(authorization.status).toBe("AUTHORIZED");
    expect(store.getScenario(scenario.id).settledPoolCents).toBe(2000);
    expect(store.availablePoolCents(scenario.id)).toBe(1900);
    expect(store.completeOrder({ orderId: order.id, idempotencyKey: key("24") })).toEqual({ status: "COMPLETED", openTabCents: 100 });
    expect(store.getScenario(scenario.id).settledPoolCents).toBe(1900);
    expect(store.listLedger(scenario.id).filter((entry) => entry.kind === "redemption_debit")).toHaveLength(1);
    expect(store.completeOrder({ orderId: order.id, idempotencyKey: key("24") })).toEqual({ status: "COMPLETED", openTabCents: 100 });
  });

  it("uses database-time expiry for availability and rejects late completion", () => {
    const { store, clock, scenario } = setup();
    const { order } = redemption(store, scenario.id, 450, 100, 3);
    clock.advance(120_001);
    expect(store.availablePoolCents(scenario.id)).toBe(2000);
    expect(store.completeOrder({ orderId: order.id, idempotencyKey: key("34") })).toEqual({ status: "AUTHORIZATION_EXPIRED", openTabCents: 0, error: "AUTHORIZATION_EXPIRED" });
    expect(store.getOrder(order.id).status).toBe("authorization_expired");
    expect(store.expireReservations()).toBe(0); // completion persisted the terminal state
  });

  it("enforces active same-device reservations as daily commitments", () => {
    const { store, scenario } = setup(3_000);
    redemption(store, scenario.id, 550, 500, 4, "device-limit");
    redemption(store, scenario.id, 550, 500, 5, "device-limit");
    const order = store.createOrder({ scenarioId: scenario.id, merchantId: "bakery", totalCents: 450, idempotencyKey: key("61") });
    const claim = store.createClaim({ orderId: order.id, idempotencyKey: key("62") });
    expect(() => store.authorize({ token: claim.token, amountCents: 1, deviceHash: "device-limit", idempotencyKey: key("63") })).toThrow(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
  });

  it("allocates successive partial refunds cumulatively and reconciles the unsettled receivable", () => {
    const { store, scenario } = setup();
    const { order } = redemption(store, scenario.id, 450, 100, 7);
    store.completeOrder({ orderId: order.id, idempotencyKey: key("74") });
    expect(store.refundOrder({ orderId: order.id, requestedCents: 200, externalId: "refund-a", idempotencyKey: key("75") })).toMatchObject({ customerDeltaCents: 200, poolDeltaCents: 0 });
    expect(store.refundOrder({ orderId: order.id, requestedCents: 200, externalId: "refund-b", idempotencyKey: key("76") })).toMatchObject({ customerDeltaCents: 150, poolDeltaCents: 50 });
    expect(store.getScenario(scenario.id).settledPoolCents).toBe(1950);
    const receivable = store.listReceivables(scenario.id)[0];
    expect(receivable).toMatchObject({ originalCents: 100, reducedCents: 50, status: "unsettled" });
  });

  it("keeps settled refund value unavailable until merchant debt recovery", () => {
    const { store, scenario } = setup();
    const { order } = redemption(store, scenario.id, 100, 100, 8);
    const receivable = store.listReceivables(scenario.id)[0];
    store.settleReceivable({ receivableId: receivable.id, idempotencyKey: key("85") });
    expect(store.getScenario(scenario.id).settledPoolCents).toBe(1900);
    expect(store.refundOrder({ orderId: order.id, requestedCents: 100, externalId: "settled-refund", idempotencyKey: key("86") })).toMatchObject({ poolDeltaCents: 100, merchantDebtCents: 100 });
    expect(store.getScenario(scenario.id).settledPoolCents).toBe(1900);
    const debt = store.listDebts(scenario.id)[0];
    store.repayDebt({ debtId: debt.id, amountCents: 100, idempotencyKey: key("87") });
    expect(store.getScenario(scenario.id).settledPoolCents).toBe(2000);
  });

  it("rejects changed-payload idempotency key reuse", () => {
    const { store, scenario } = setup();
    store.createOrder({ scenarioId: scenario.id, merchantId: "cafe", totalCents: 100, idempotencyKey: key("91") });
    expect(() => store.createOrder({ scenarioId: scenario.id, merchantId: "cafe", totalCents: 200, idempotencyKey: key("91") })).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
  });

  it("does not use cancellation as a post-completion reversal", () => {
    const { store, scenario } = setup();
    const { order } = redemption(store, scenario.id, 100, 100, 10);
    expect(() => store.failOrCancelOrder({ orderId: order.id, reason: "cancelled", idempotencyKey: key("104") })).toThrow(expect.objectContaining({ code: "ORDER_COMPLETED_USE_REFUND" }));
  });

  it("rolls back mutations when a scenario expires midway through the operation", () => {
    const { store, clock, scenario } = setup();
    const contribution = store.createOrder({ scenarioId: scenario.id, merchantId: "cafe", totalCents: 780, idempotencyKey: key("111") });
    clock.advance(24 * 60 * 60_000 + 1);
    expect(() => store.settleRoundup({ orderId: contribution.id, processorSucceeded: true, idempotencyKey: key("112") })).toThrow(expect.objectContaining({ code: "SCENARIO_EXPIRED" }));
    expect(store.getOrder(contribution.id).status).toBe("open");
  });

  it("validates policy values and idempotency UUIDs", () => {
    const store = new InMemoryOpenTabStore();
    expect(() => store.createScenario({ policy: { deviceDailyLimitCents: 0 } })).toThrow(expect.objectContaining({ code: "INVALID_POLICY" }));
    const scenario = store.createScenario();
    expect(() => store.createOrder({ scenarioId: scenario.id, merchantId: "cafe", totalCents: 100, idempotencyKey: "not-a-uuid" })).toThrow(expect.objectContaining({ code: "INVALID_IDEMPOTENCY_KEY" }));
  });

  it("requires a strong bootstrap secret and aggregates recovery ledger credits", () => {
    const { store, scenario } = setup();
    expect(() => store.createOrRecoverScenario({ bootstrapSecret: "", idempotencyKey: key("161") })).toThrow(expect.objectContaining({ code: "INVALID_BOOTSTRAP_SECRET" }));
    const { order } = redemption(store, scenario.id, 100, 100, 162);
    const receivable = store.listReceivables(scenario.id)[0];
    store.settleReceivable({ receivableId: receivable.id, idempotencyKey: key("163") });
    store.refundOrder({ orderId: order.id, requestedCents: 100, externalId: "aggregate-refund", idempotencyKey: key("164") });
    store.repayDebt({ debtId: store.listDebts(scenario.id)[0].id, amountCents: 100, idempotencyKey: key("165") });
    expect(store.listLedger(scenario.id).filter((entry) => entry.kind === "merchant_recovery_credit")).toHaveLength(1);
  });

  it("rolls back expired-scenario refund and recovery attempts", () => {
    const { store, clock, scenario } = setup();
    const { order } = redemption(store, scenario.id, 100, 100, 12);
    const receivable = store.listReceivables(scenario.id)[0];
    store.settleReceivable({ receivableId: receivable.id, idempotencyKey: key("125") });
    store.refundOrder({ orderId: order.id, requestedCents: 100, externalId: "create-debt", idempotencyKey: key("126") });
    const debt = store.listDebts(scenario.id)[0];
    clock.advance(24 * 60 * 60_000 + 1);
    expect(() => store.refundOrder({ orderId: order.id, requestedCents: 1, externalId: "late", idempotencyKey: key("127") })).toThrow(expect.objectContaining({ code: "SCENARIO_EXPIRED" }));
    expect(() => store.repayDebt({ debtId: debt.id, amountCents: 1, idempotencyKey: key("128") })).toThrow(expect.objectContaining({ code: "SCENARIO_EXPIRED" }));
    expect(store.getOrder(order.id).refundedCents).toBe(100);
    expect(store.listDebts(scenario.id)[0].recoveredCents).toBe(0);
  });

  it("replays claim creation by deriving the same credential without a stored bearer value", () => {
    const { store, scenario } = setup();
    const order = store.createOrder({ scenarioId: scenario.id, merchantId: "bakery", totalCents: 450, idempotencyKey: key("131") });
    const first = store.createClaim({ orderId: order.id, idempotencyKey: key("132") });
    const replay = store.createClaim({ orderId: order.id, idempotencyKey: key("132") });
    expect(replay).toEqual(first);
  });

  it("fails closed for a missing production credential secret", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPEN_TAB_CREDENTIAL_SECRET", "");
    expect(() => deriveOwnerToken("a-scenario")).toThrow("OPEN_TAB_CREDENTIAL_SECRET");
    vi.unstubAllEnvs();
  });
});
