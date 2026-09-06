import { createHash, randomUUID } from "node:crypto";
import { deriveClaimToken, deriveOwnerToken, hashToken } from "./credentials";
import { assertCents, roundUpContributionCents } from "./money";
import { systemClock, type Clock } from "./time";
import {
  type Claim, type DeviceRedemption, DomainError, type IdempotencyRecord, type LedgerEntry,
  type MerchantDebt, type Order, type Policy, type Receivable, type RefundEvent,
  type Reservation, type Scenario,
} from "./types";

export const DEFAULT_POLICY: Policy = {
  activationThresholdCents: 2_000,
  perOrderLimitCents: 500,
  deviceDailyLimitCents: 1_000,
  claimLifetimeMs: 5 * 60_000,
  authorizationLifetimeMs: 2 * 60_000,
};

export interface AuthorizeResult {
  status: "AUTHORIZED" | "COMPLETED";
  reservationId: string;
  amountCents: number;
  remainingTenderCents: number;
  expiresAt?: Date;
}

export interface RefundResult {
  customerDeltaCents: number;
  poolDeltaCents: number;
  merchantDebtCents: number;
  cumulativeRefundedCents: number;
}

export type CompleteResult =
  | { status: "COMPLETED"; openTabCents: number }
  | { status: "AUTHORIZATION_EXPIRED"; openTabCents: 0; error: "AUTHORIZATION_EXPIRED" };

type StoreData = {
  scenarios: Map<string, Scenario>;
  orders: Map<string, Order>;
  claims: Map<string, Claim>;
  reservations: Map<string, Reservation>;
  ledger: LedgerEntry[];
  receivables: Map<string, Receivable>;
  debts: Map<string, MerchantDebt>;
  deviceRedemptions: DeviceRedemption[];
  refunds: RefundEvent[];
  idempotency: Map<string, IdempotencyRecord>;
  bootstraps: Map<string, { scenarioId: string; expiresAt: Date }>;
};

/**
 * Demo-only persistence adapter. It intentionally mirrors the transactional rules that
 * the SQL functions enforce, while keeping a fresh process runnable without Supabase.
 */
export class InMemoryOpenTabStore {
  private readonly data: StoreData = {
    scenarios: new Map(), orders: new Map(), claims: new Map(), reservations: new Map(),
    ledger: [], receivables: new Map(), debts: new Map(), deviceRedemptions: [], refunds: [],
    idempotency: new Map(), bootstraps: new Map(),
  };

  constructor(private readonly clock: Clock = systemClock) {}

  createScenario(input: { seedPoolCents?: number; expiresAt?: Date; policy?: Partial<Policy> } = {}): Scenario {
    return this.atomic(() => {
      const seed = input.seedPoolCents ?? 2_000;
      assertCents(seed, "seedPoolCents");
      const policy = { ...DEFAULT_POLICY, ...input.policy };
      this.validatePolicy(policy);
      const scenario: Scenario = {
      id: randomUUID(), currency: "EUR", settledPoolCents: seed,
      activated: seed >= policy.activationThresholdCents,
      expiresAt: input.expiresAt ?? new Date(this.clock.now().getTime() + 24 * 60 * 60_000),
      policy,
      };
      if (scenario.expiresAt <= this.clock.now()) throw new DomainError("INVALID_SCENARIO_EXPIRY");
      this.data.scenarios.set(scenario.id, scenario);
      if (seed > 0) this.ledger(scenario.id, "historical_contribution_credit", seed);
      return this.copy(scenario);
    });
  }

  /**
   * Isolated demo bootstrap/recovery. A replay is only accepted while both the
   * bootstrap authority and the scenario itself are live; expired authority never
   * reissues an owner credential.
   */
  createOrRecoverScenario(input: { bootstrapSecret: string; idempotencyKey: string }): { scenario: Scenario; ownerToken: string; csrfToken: string } {
    this.assertUuid(input.idempotencyKey);
    if (input.bootstrapSecret.length < 32) throw new DomainError("INVALID_BOOTSTRAP_SECRET");
    return this.atomic(() => {
      const now = this.clock.now();
      const bootstrapHash = hashToken(input.bootstrapSecret);
      const recordKey = `${bootstrapHash}:${input.idempotencyKey}`;
      const existing = this.data.bootstraps.get(recordKey);
      if (existing) {
        if (existing.expiresAt <= now) throw new DomainError("BOOTSTRAP_EXPIRED");
        const scenario = this.scenario(existing.scenarioId); // effective expiry check before replay
        return { scenario: this.copy(scenario), ownerToken: deriveOwnerToken(scenario.id), csrfToken: this.csrfFor(scenario.id) };
      }
      const scenario = this.createScenario();
      this.data.bootstraps.set(recordKey, { scenarioId: scenario.id, expiresAt: new Date(now.getTime() + 10 * 60_000) });
      return { scenario, ownerToken: deriveOwnerToken(scenario.id), csrfToken: this.csrfFor(scenario.id) };
    });
  }

  getScenario(scenarioId: string): Scenario { return this.copy(this.scenario(scenarioId)); }
  ownerTokenForScenario(scenarioId: string): string { this.scenario(scenarioId); return deriveOwnerToken(scenarioId); }
  csrfFor(scenarioId: string): string { this.scenario(scenarioId); return hashToken(`csrf:${scenarioId}`); }
  getClaimForExchange(token: string): Claim {
    const claim = this.claimByToken(token);
    this.scenario(claim.scenarioId);
    if (claim.cancelledAt || claim.expiresAt <= this.clock.now()) throw new DomainError("CLAIM_EXPIRED");
    return this.copy(claim);
  }
  exchangeClaimToken(token: string): Claim {
    return this.atomic(() => {
      const claim = this.claimByToken(token);
      this.scenario(claim.scenarioId);
      if (claim.cancelledAt || claim.expiresAt <= this.clock.now()) throw new DomainError("CLAIM_EXPIRED");
      claim.claimSessionExpiresAt = new Date(this.clock.now().getTime() + 10 * 60_000);
      return this.copy(claim);
    });
  }
  getClaim(claimId: string): Claim {
    const claim = this.data.claims.get(claimId);
    if (!claim) throw new DomainError("CLAIM_NOT_FOUND");
    this.scenario(claim.scenarioId);
    return this.copy(claim);
  }
  getOrder(orderId: string): Order {
    const order = this.copy(this.order(orderId));
    if (order.status === "authorized") {
      const reservation = [...this.data.reservations.values()].find((entry) => entry.orderId === order.id && entry.status === "authorized");
      if (reservation && reservation.expiresAt <= this.clock.now()) order.status = "authorization_expired";
    }
    return order;
  }
  listLedger(scenarioId: string): LedgerEntry[] { return this.data.ledger.filter((entry) => entry.scenarioId === scenarioId).map((entry) => this.copy(entry)); }

  availablePoolCents(scenarioId: string): number {
    const scenario = this.scenario(scenarioId);
    const now = this.clock.now().getTime();
    const reserved = [...this.data.reservations.values()]
      .filter((reservation) => reservation.scenarioId === scenarioId && reservation.status === "authorized" && reservation.expiresAt.getTime() > now)
      .reduce((sum, reservation) => sum + reservation.amountCents, 0);
    return scenario.settledPoolCents - reserved;
  }

  createOrder(input: { scenarioId: string; merchantId: string; totalCents: number; idempotencyKey: string; requestFingerprint?: unknown }): Order {
    return this.idempotent(input.scenarioId, "create_order", input.idempotencyKey, input.requestFingerprint ?? input, () => {
      assertCents(input.totalCents, "totalCents");
      if (input.totalCents === 0) throw new DomainError("INVALID_AMOUNT");
      const order: Order = {
        id: randomUUID(), scenarioId: input.scenarioId, merchantId: input.merchantId, totalCents: input.totalCents,
        openTabCents: 0, customerTenderCents: input.totalCents, remainingTenderCents: input.totalCents, status: "open", refundableCents: input.totalCents,
        refundedCents: 0, customerRefundedCents: 0, poolRefundedCents: 0, createdAt: this.clock.now(),
      };
      this.scenario(input.scenarioId);
      this.data.orders.set(order.id, order);
      return this.copy(order);
    });
  }

  settleRoundup(input: { orderId: string; processorSucceeded: boolean; acceptRoundup?: boolean; idempotencyKey: string }): { contributionCents: number; status: "COMPLETED" | "DECLINED" } {
    const order = this.order(input.orderId);
    return this.idempotent(order.scenarioId, "roundup", input.idempotencyKey, input, () => {
      if (order.status !== "open") throw new DomainError("ORDER_CLOSED");
      if (!input.processorSucceeded) { order.status = "payment_failed"; return { contributionCents: 0, status: "DECLINED" }; }
      const contributionCents = input.acceptRoundup === false ? 0 : roundUpContributionCents(order.totalCents);
      order.status = "completed";
      order.remainingTenderCents = 0;
      if (contributionCents > 0) {
        this.adjustPool(order.scenarioId, contributionCents);
        this.ledger(order.scenarioId, "roundup_credit", contributionCents, order);
        this.activateIfThresholdReached(this.scenario(order.scenarioId));
      }
      return { contributionCents, status: "COMPLETED" };
    });
  }

  createClaim(input: { orderId: string; idempotencyKey: string }): { claimId: string; token: string; expiresAt: Date } {
    const order = this.order(input.orderId);
    this.assertUuid(input.idempotencyKey);
    return this.atomic(() => {
    this.scenario(order.scenarioId);
    const operation = "create_claim";
    const recordKey = `${order.scenarioId}:${operation}:${input.idempotencyKey}`;
    const requestHash = createHash("sha256").update(this.canonical(input)).digest("hex");
    const existing = this.data.idempotency.get(recordKey);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT");
      const replay = existing.response as { claimId: string; expiresAt: Date };
      const claim = this.data.claims.get(replay.claimId);
      if (!claim) throw new DomainError("CLAIM_NOT_FOUND");
      return { claimId: claim.id, token: deriveClaimToken(claim.scenarioId, claim.id, claim.generation), expiresAt: new Date(claim.expiresAt) };
    }
    const response = (() => {
      if (order.status !== "open") throw new DomainError("ORDER_CLOSED");
      for (const claim of this.data.claims.values()) {
        if (claim.orderId === order.id && !claim.cancelledAt && !claim.consumedAt) {
          // Rotating the QR replaces an active claim; the idempotency record above
          // still makes retries of the same request replay the original claim.
          claim.cancelledAt = this.clock.now();
        }
      }
      const claimId = randomUUID();
      const claim: Claim = { id: claimId, scenarioId: order.scenarioId, orderId: order.id, generation: 1,
        tokenHash: hashToken(deriveClaimToken(order.scenarioId, claimId, 1)), expiresAt: new Date(this.clock.now().getTime() + this.scenario(order.scenarioId).policy.claimLifetimeMs) };
      this.data.claims.set(claim.id, claim);
      // Idempotency state must not retain a bearer token; HMAC derivation reissues it.
      this.data.idempotency.set(recordKey, { scenarioId: order.scenarioId, operation, key: input.idempotencyKey, requestHash, response: { claimId, expiresAt: new Date(claim.expiresAt) } });
      return { claimId, token: deriveClaimToken(order.scenarioId, claim.id, claim.generation), expiresAt: new Date(claim.expiresAt) };
    })();
    return response;
    });
  }

  authorize(input: { token: string; amountCents: number; deviceHash: string; idempotencyKey: string }): AuthorizeResult {
    const claim = this.claimByToken(input.token);
    return this.idempotent(claim.scenarioId, "authorize_claim", input.idempotencyKey, { ...input, token: hashToken(input.token) }, () => {
      const now = this.clock.now();
      const order = this.order(claim.orderId);
      const scenario = this.scenario(claim.scenarioId);
      assertCents(input.amountCents);
      if (claim.cancelledAt || claim.expiresAt <= now) throw new DomainError("CLAIM_EXPIRED");
      if (claim.consumedAt || order.status !== "open") throw new DomainError("CLAIM_USED");
      if (input.amountCents === 0 || input.amountCents > order.remainingTenderCents || input.amountCents > scenario.policy.perOrderLimitCents) throw new DomainError("INVALID_ASSISTANCE_AMOUNT");
      if (!scenario.activated) throw new DomainError("POOL_INACTIVE");
      if (input.amountCents > this.availablePoolCents(scenario.id)) throw new DomainError("INSUFFICIENT_POOL");
      if (this.deviceCommitmentCents(scenario.id, input.deviceHash, now) + input.amountCents > scenario.policy.deviceDailyLimitCents) throw new DomainError("LIMIT_EXCEEDED");
      const reservation: Reservation = { id: randomUUID(), scenarioId: scenario.id, claimId: claim.id, orderId: order.id, deviceHash: input.deviceHash,
        amountCents: input.amountCents, expiresAt: new Date(now.getTime() + scenario.policy.authorizationLifetimeMs), status: "authorized", createdAt: now };
      this.data.reservations.set(reservation.id, reservation);
      claim.consumedAt = now;
      order.openTabCents = input.amountCents;
      order.customerTenderCents = order.totalCents - input.amountCents;
      order.remainingTenderCents = order.customerTenderCents;
      if (order.remainingTenderCents === 0) {
        this.finalizeReservation(reservation, order);
        return { status: "COMPLETED", reservationId: reservation.id, amountCents: reservation.amountCents, remainingTenderCents: 0 };
      }
      order.status = "authorized";
      return { status: "AUTHORIZED", reservationId: reservation.id, amountCents: reservation.amountCents, remainingTenderCents: order.remainingTenderCents, expiresAt: new Date(reservation.expiresAt) };
    });
  }

  /** Server-only route adapter: the claim-session cookie identifies a claim but never exposes its QR bearer. */
  authorizeClaim(input: { claimId: string; amountCents: number; deviceHash: string; idempotencyKey: string }): AuthorizeResult {
    const claim = this.getClaim(input.claimId);
    return this.authorize({ ...input, token: deriveClaimToken(claim.scenarioId, claim.id, claim.generation) });
  }

  completeOrder(input: { orderId: string; idempotencyKey: string }): CompleteResult {
    const order = this.order(input.orderId);
    return this.idempotent(order.scenarioId, "complete_order", input.idempotencyKey, input, () => {
      if (order.status !== "authorized") throw new DomainError("ORDER_CLOSED");
      const reservation = this.reservationForOrder(order.id);
      if (reservation.expiresAt <= this.clock.now()) {
        reservation.status = "expired";
        order.status = "authorization_expired";
        return { status: "AUTHORIZATION_EXPIRED", openTabCents: 0, error: "AUTHORIZATION_EXPIRED" };
      }
      this.finalizeReservation(reservation, order);
      return { status: "COMPLETED", openTabCents: order.openTabCents };
    });
  }

  failOrCancelOrder(input: { orderId: string; idempotencyKey: string; reason: "failed" | "cancelled" }): { status: "payment_failed" | "cancelled" } {
    const order = this.order(input.orderId);
    return this.idempotent(order.scenarioId, `close_${input.reason}`, input.idempotencyKey, input, () => {
      if (order.status === "completed" || order.status === "partially_refunded" || order.status === "refunded") throw new DomainError("ORDER_COMPLETED_USE_REFUND");
      if (order.status === "authorized") this.reservationForOrder(order.id).status = "cancelled";
      if (order.status !== "open" && order.status !== "authorized") throw new DomainError("ORDER_CLOSED");
      order.status = input.reason === "failed" ? "payment_failed" : "cancelled";
      return { status: order.status };
    });
  }

  expireReservations(): number {
    return this.atomic(() => {
    const now = this.clock.now(); let count = 0;
    for (const reservation of this.data.reservations.values()) {
      if (reservation.status === "authorized" && reservation.expiresAt <= now) {
        reservation.status = "expired";
        const order = this.order(reservation.orderId);
        if (order.status === "authorized") order.status = "payment_failed";
        count++;
      }
    }
    return count;
    });
  }

  refundOrder(input: { orderId: string; requestedCents: number; externalId: string; idempotencyKey: string }): RefundResult {
    const order = this.order(input.orderId);
    return this.idempotent(order.scenarioId, "refund", input.idempotencyKey, input, () => {
      assertCents(input.requestedCents, "requestedCents");
      if (!["completed", "partially_refunded"].includes(order.status)) throw new DomainError("ORDER_NOT_REFUNDABLE");
      if (this.data.refunds.some((refund) => refund.orderId === order.id && refund.externalId === input.externalId)) throw new DomainError("DUPLICATE_REFUND_EVENT");
      const nextTotal = order.refundedCents + input.requestedCents;
      if (input.requestedCents === 0 || nextTotal > order.refundableCents) throw new DomainError("REFUND_EXCEEDS_ORDER");
      const nextCustomer = Math.min(nextTotal, order.customerTenderCents);
      const nextPool = Math.min(order.openTabCents, Math.max(0, nextTotal - order.customerTenderCents));
      const customerDeltaCents = nextCustomer - order.customerRefundedCents;
      const poolDeltaCents = nextPool - order.poolRefundedCents;
      order.refundedCents = nextTotal; order.customerRefundedCents = nextCustomer; order.poolRefundedCents = nextPool;
      order.status = nextTotal === order.refundableCents ? "refunded" : "partially_refunded";
      const event: RefundEvent = { id: randomUUID(), scenarioId: order.scenarioId, orderId: order.id, externalId: input.externalId, requestedCents: input.requestedCents, customerDeltaCents, poolDeltaCents, createdAt: this.clock.now() };
      this.data.refunds.push(event);
      let merchantDebtCents = 0;
      if (poolDeltaCents > 0) {
        this.reduceDeviceUsage(order.id, poolDeltaCents);
        const receivable = this.receivableForOrder(order.id);
        if (receivable.status === "unsettled") {
          receivable.reducedCents += poolDeltaCents;
          if (this.receivableResidual(receivable) === 0) receivable.status = "fully_reversed";
          this.adjustPool(order.scenarioId, poolDeltaCents);
          this.ledger(order.scenarioId, "redemption_reversal_credit", poolDeltaCents, order, event.id);
        } else {
          merchantDebtCents = poolDeltaCents;
          const debt: MerchantDebt = { id: randomUUID(), scenarioId: order.scenarioId, merchantId: order.merchantId, orderId: order.id, amountCents: poolDeltaCents, recoveredCents: 0 };
          this.data.debts.set(debt.id, debt);
        }
      }
      return { customerDeltaCents, poolDeltaCents, merchantDebtCents, cumulativeRefundedCents: nextTotal };
    });
  }

  settleReceivable(input: { receivableId: string; idempotencyKey: string }): { merchantPayoutCents: number; recoveredCents: number } {
    const receivable = this.data.receivables.get(input.receivableId);
    if (!receivable) throw new DomainError("RECEIVABLE_NOT_FOUND");
    return this.idempotent(receivable.scenarioId, "settle_receivable", input.idempotencyKey, input, () => {
      if (receivable.status !== "unsettled") throw new DomainError("RECEIVABLE_NOT_SETTLEABLE");
      const residual = this.receivableResidual(receivable);
      if (residual <= 0) throw new DomainError("RECEIVABLE_NOT_SETTLEABLE");
      let remaining = residual; let recoveredCents = 0;
      for (const debt of this.data.debts.values()) {
        if (debt.scenarioId !== receivable.scenarioId || debt.merchantId !== receivable.merchantId || remaining === 0) continue;
        const recovery = Math.min(remaining, debt.amountCents - debt.recoveredCents);
        if (recovery <= 0) continue;
        debt.recoveredCents += recovery; remaining -= recovery; recoveredCents += recovery;
        this.adjustPool(receivable.scenarioId, recovery);
      }
      if (recoveredCents > 0) this.ledger(receivable.scenarioId, "merchant_recovery_credit", recoveredCents, this.order(receivable.orderId));
      receivable.settledCents = residual; receivable.status = "settled";
      return { merchantPayoutCents: remaining, recoveredCents };
    });
  }

  repayDebt(input: { debtId: string; amountCents: number; idempotencyKey: string }): { recoveredCents: number } {
    const debt = this.data.debts.get(input.debtId);
    if (!debt) throw new DomainError("DEBT_NOT_FOUND");
    return this.idempotent(debt.scenarioId, "repay_debt", input.idempotencyKey, input, () => {
      assertCents(input.amountCents);
      const outstanding = debt.amountCents - debt.recoveredCents;
      if (input.amountCents === 0 || input.amountCents > outstanding) throw new DomainError("INVALID_RECOVERY_AMOUNT");
      debt.recoveredCents += input.amountCents;
      this.adjustPool(debt.scenarioId, input.amountCents);
      this.ledger(debt.scenarioId, "merchant_recovery_credit", input.amountCents, this.order(debt.orderId), debt.id);
      return { recoveredCents: input.amountCents };
    });
  }

  listReceivables(scenarioId: string): Receivable[] { return [...this.data.receivables.values()].filter((record) => record.scenarioId === scenarioId).map((record) => this.copy(record)); }
  listDebts(scenarioId: string): MerchantDebt[] { return [...this.data.debts.values()].filter((record) => record.scenarioId === scenarioId).map((record) => this.copy(record)); }

  private finalizeReservation(reservation: Reservation, order: Order): void {
    if (reservation.status !== "authorized") throw new DomainError("RESERVATION_CLOSED");
    reservation.status = "completed"; order.status = "completed"; order.remainingTenderCents = 0;
    this.adjustPool(order.scenarioId, -reservation.amountCents);
    this.ledger(order.scenarioId, "redemption_debit", -reservation.amountCents, order, reservation.id);
    const receivable: Receivable = { id: randomUUID(), scenarioId: order.scenarioId, orderId: order.id, merchantId: order.merchantId, originalCents: reservation.amountCents, reducedCents: 0, settledCents: 0, status: "unsettled" };
    this.data.receivables.set(receivable.id, receivable);
    this.data.deviceRedemptions.push({ id: randomUUID(), scenarioId: order.scenarioId, orderId: order.id, deviceHash: reservation.deviceHash, completedAt: this.clock.now(), grossCents: reservation.amountCents, poolReversedCents: 0 });
  }

  private deviceCommitmentCents(scenarioId: string, deviceHash: string, now: Date): number {
    const since = now.getTime() - 24 * 60 * 60_000;
    const completed = this.data.deviceRedemptions.filter((record) => record.scenarioId === scenarioId && record.deviceHash === deviceHash && record.completedAt.getTime() >= since).reduce((sum, record) => sum + record.grossCents - record.poolReversedCents, 0);
    const active = [...this.data.reservations.values()].filter((record) => record.scenarioId === scenarioId && record.deviceHash === deviceHash && record.status === "authorized" && record.expiresAt > now).reduce((sum, record) => sum + record.amountCents, 0);
    return completed + active;
  }

  private reduceDeviceUsage(orderId: string, amountCents: number): void {
    const record = this.data.deviceRedemptions.find((entry) => entry.orderId === orderId);
    if (!record) throw new DomainError("DEVICE_REDEMPTION_NOT_FOUND");
    if (record.poolReversedCents + amountCents > record.grossCents) throw new DomainError("REFUND_EXCEEDS_ASSISTANCE");
    record.poolReversedCents += amountCents;
  }

  private reservationForOrder(orderId: string): Reservation {
    const reservation = [...this.data.reservations.values()].find((record) => record.orderId === orderId && record.status === "authorized");
    if (!reservation) throw new DomainError("AUTHORIZATION_NOT_FOUND");
    return reservation;
  }
  private receivableForOrder(orderId: string): Receivable {
    const receivable = [...this.data.receivables.values()].find((record) => record.orderId === orderId);
    if (!receivable) throw new DomainError("RECEIVABLE_NOT_FOUND");
    return receivable;
  }
  private receivableResidual(receivable: Receivable): number { return receivable.originalCents - receivable.reducedCents - receivable.settledCents; }
  private scenario(id: string): Scenario { const result = this.data.scenarios.get(id); if (!result) throw new DomainError("SCENARIO_NOT_FOUND"); if (result.expiresAt <= this.clock.now()) throw new DomainError("SCENARIO_EXPIRED"); return result; }
  private order(id: string): Order { const result = this.data.orders.get(id); if (!result) throw new DomainError("ORDER_NOT_FOUND"); return result; }
  private claimByToken(token: string): Claim { const hash = hashToken(token); const result = [...this.data.claims.values()].find((claim) => claim.tokenHash === hash); if (!result) throw new DomainError("CLAIM_NOT_FOUND"); return result; }
  private adjustPool(scenarioId: string, deltaCents: number): void { const scenario = this.scenario(scenarioId); if (scenario.settledPoolCents + deltaCents < 0) throw new DomainError("INSUFFICIENT_POOL"); scenario.settledPoolCents += deltaCents; }
  private ledger(scenarioId: string, kind: LedgerEntry["kind"], amountCents: number, order?: Order, referenceId?: string): void { this.data.ledger.push({ id: randomUUID(), scenarioId, orderId: order?.id, merchantId: order?.merchantId, kind, amountCents, referenceId, createdAt: this.clock.now() }); }
  private idempotent<T>(scenarioId: string, operation: string, key: string, request: unknown, action: () => T): T {
    this.assertUuid(key);
    return this.atomic(() => {
    this.scenario(scenarioId);
    const recordKey = `${scenarioId}:${operation}:${key}`; const requestHash = createHash("sha256").update(this.canonical(request)).digest("hex");
    const existing = this.data.idempotency.get(recordKey);
    if (existing) { if (existing.requestHash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT"); return this.copy(existing.response as T); }
    const response = action(); this.data.idempotency.set(recordKey, { scenarioId, operation, key, requestHash, response: this.copy(response) }); return this.copy(response);
    });
  }
  private canonical(value: unknown): string {
    const normalize = (input: unknown): unknown => {
      if (input instanceof Date) return input.toISOString();
      if (Array.isArray(input)) return input.map(normalize);
      if (input && typeof input === "object") return Object.fromEntries(Object.keys(input as object).sort().map((key) => [key, normalize((input as Record<string, unknown>)[key])]));
      return input;
    };
    return JSON.stringify(normalize(value));
  }
  private assertUuid(value: string): void { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new DomainError("INVALID_IDEMPOTENCY_KEY"); }
  private validatePolicy(policy: Policy): void {
    assertCents(policy.activationThresholdCents, "activationThresholdCents");
    for (const [name, value] of Object.entries(policy)) if (!Number.isSafeInteger(value) || (name !== "activationThresholdCents" && value <= 0)) throw new DomainError("INVALID_POLICY", `${name} must be a positive integer`);
  }
  private activateIfThresholdReached(scenario: Scenario): void { if (!scenario.activated && scenario.settledPoolCents >= scenario.policy.activationThresholdCents) scenario.activated = true; }
  private atomic<T>(action: () => T): T { const snapshot = this.copy(this.data); try { return action(); } catch (error) { Object.assign(this.data, snapshot); throw error; } }
  private copy<T>(value: T): T { return structuredClone(value); }
}
