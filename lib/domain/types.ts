export type Id = string;

export type OrderStatus = "open" | "authorized" | "authorization_expired" | "completed" | "payment_failed" | "cancelled" | "partially_refunded" | "refunded";
export type ReservationStatus = "authorized" | "completed" | "expired" | "cancelled";
export type ReceivableStatus = "unsettled" | "settled" | "fully_reversed";
export type LedgerKind =
  | "historical_contribution_credit"
  | "roundup_credit"
  | "redemption_debit"
  | "redemption_reversal_credit"
  | "merchant_recovery_credit";

export interface Policy {
  activationThresholdCents: number;
  perOrderLimitCents: number;
  deviceDailyLimitCents: number;
  claimLifetimeMs: number;
  authorizationLifetimeMs: number;
}

export interface Scenario {
  id: Id;
  currency: "EUR";
  settledPoolCents: number;
  activated: boolean;
  expiresAt: Date;
  policy: Policy;
}

export interface Order {
  id: Id;
  scenarioId: Id;
  merchantId: Id;
  totalCents: number;
  openTabCents: number;
  /** Contracted customer portion; immutable after authorization. */
  customerTenderCents: number;
  /** Tender still unpaid. It reaches zero after successful payment. */
  remainingTenderCents: number;
  status: OrderStatus;
  refundableCents: number;
  refundedCents: number;
  customerRefundedCents: number;
  poolRefundedCents: number;
  createdAt: Date;
}

export interface Claim {
  id: Id;
  scenarioId: Id;
  orderId: Id;
  tokenHash: string;
  generation: number;
  expiresAt: Date;
  consumedAt?: Date;
  cancelledAt?: Date;
  claimSessionExpiresAt?: Date;
}

export interface Reservation {
  id: Id;
  scenarioId: Id;
  claimId: Id;
  orderId: Id;
  deviceHash: string;
  amountCents: number;
  expiresAt: Date;
  status: ReservationStatus;
  createdAt: Date;
}

export interface LedgerEntry {
  id: Id;
  scenarioId: Id;
  orderId?: Id;
  merchantId?: Id;
  kind: LedgerKind;
  amountCents: number;
  createdAt: Date;
  referenceId?: Id;
}

export interface Receivable {
  id: Id;
  scenarioId: Id;
  orderId: Id;
  merchantId: Id;
  originalCents: number;
  reducedCents: number;
  settledCents: number;
  status: ReceivableStatus;
}

export interface MerchantDebt {
  id: Id;
  scenarioId: Id;
  merchantId: Id;
  orderId: Id;
  amountCents: number;
  recoveredCents: number;
}

export interface DeviceRedemption {
  id: Id;
  scenarioId: Id;
  orderId: Id;
  deviceHash: string;
  completedAt: Date;
  grossCents: number;
  poolReversedCents: number;
}

export interface RefundEvent {
  id: Id;
  scenarioId: Id;
  orderId: Id;
  externalId: string;
  requestedCents: number;
  customerDeltaCents: number;
  poolDeltaCents: number;
  createdAt: Date;
}

export interface IdempotencyRecord<T = unknown> {
  scenarioId: Id;
  operation: string;
  key: string;
  requestHash: string;
  response: T;
}

export class DomainError extends Error {
  constructor(public readonly code: string, message = code) {
    super(message);
    this.name = "DomainError";
  }
}
