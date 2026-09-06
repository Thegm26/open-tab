import "server-only";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { deriveClaimToken, deriveCsrfToken, deriveOwnerToken, hashToken } from "@/lib/domain/credentials";
import { DomainError, type Claim, type LedgerEntry, type MerchantDebt, type Order, type Policy, type Receivable, type Scenario } from "@/lib/domain/types";
import { DEFAULT_POLICY, type AuthorizeResult, type CompleteResult, type RefundResult } from "@/lib/domain/store";

/** Production adapter. The service-role key is read only in this server-only module. */
export class SupabaseOpenTabStore {
  private readonly db: SupabaseClient;
  constructor(url = process.env.SUPABASE_URL, serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY) {
    if (!url || !serviceRole) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    this.db = createClient(url, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  private async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.db.rpc(name, args);
    if (error) throw new DomainError(error.message.match(/[A-Z][A-Z0-9_]+/)?.[0] ?? "PERSISTENCE_ERROR", error.message);
    return data as T;
  }
  private async one<T>(table: string, id: string, missing: string): Promise<T> {
    const { data, error } = await this.db.from(table).select("*").eq("id", id).maybeSingle();
    if (error) throw new DomainError("PERSISTENCE_ERROR", error.message);
    if (!data) throw new DomainError(missing);
    return data as T;
  }
  private scenarioRow(row: any): Scenario { return { id: row.id, currency: "EUR", settledPoolCents: Number(row.settled_pool_cents), activated: row.activated, expiresAt: new Date(row.expires_at), policy: { activationThresholdCents: Number(row.activation_threshold_cents), perOrderLimitCents: Number(row.per_order_limit_cents), deviceDailyLimitCents: Number(row.device_daily_limit_cents), claimLifetimeMs: Number(row.claim_lifetime_seconds) * 1000, authorizationLifetimeMs: Number(row.authorization_lifetime_seconds) * 1000 } }; }
  private orderRow(row: any): Order {
    const rawItems = row.items ?? row.line_items;
    let items = rawItems;
    if (typeof items === "string") {
      try { items = JSON.parse(items); } catch { items = undefined; }
    }
    return { id: row.id, scenarioId: row.scenario_id, merchantId: row.merchants?.slug ?? row.merchant_id, totalCents: Number(row.total_cents), openTabCents: Number(row.open_tab_cents), customerTenderCents: Number(row.customer_tender_cents), remainingTenderCents: Number(row.remaining_tender_cents), status: row.status, refundableCents: Number(row.refundable_cents), refundedCents: Number(row.refunded_cents), customerRefundedCents: Number(row.customer_refunded_cents), poolRefundedCents: Number(row.pool_refunded_cents), createdAt: new Date(row.created_at), items: Array.isArray(items) && items.length > 0 ? items : undefined };
  }
  async createOrRecoverScenario(input: { bootstrapSecret: string; idempotencyKey: string }) { if (input.bootstrapSecret.length < 32) throw new DomainError("INVALID_BOOTSTRAP_SECRET"); const out = await this.rpc<{ scenario_id: string }>("ot_bootstrap", { p_bootstrap_hash: hashToken(input.bootstrapSecret), p_bootstrap_secret: input.bootstrapSecret, p_idempotency_key: input.idempotencyKey }); const scenario = await this.getScenario(out.scenario_id); await this.rpc("ot_set_owner_hash", { p_scenario: scenario.id, p_owner_token_hash: hashToken(deriveOwnerToken(scenario.id)) }); return { scenario, ownerToken: deriveOwnerToken(scenario.id), csrfToken: deriveCsrfToken(scenario.id) }; }
  async getScenario(id: string) { const scenario = this.scenarioRow(await this.one("demo_scenarios", id, "SCENARIO_NOT_FOUND")); if (scenario.expiresAt <= new Date()) throw new DomainError("SCENARIO_EXPIRED"); return scenario; }
  async ownerTokenForScenario(id: string) { await this.getScenario(id); return deriveOwnerToken(id); }
  async csrfFor(id: string) { await this.getScenario(id); return deriveCsrfToken(id); }
  async getOrder(id: string) {
    const order = this.orderRow(await this.rpc<any>("ot_get_order", { p_order: id }));
    // ot_get_order returns the FK; the browser catalog uses the merchant slug.
    if (order.merchantId !== "cafe" && order.merchantId !== "bakery") {
      const { data, error } = await this.db.from("merchants").select("slug").eq("id", order.merchantId).maybeSingle();
      if (error) throw new DomainError("PERSISTENCE_ERROR", error.message);
      if (data?.slug === "cafe" || data?.slug === "bakery") order.merchantId = data.slug;
    }
    return order;
  }
  async latestOrder(): Promise<Order | undefined> {
    const { data, error } = await this.db.from("orders").select("id").order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw new DomainError("PERSISTENCE_ERROR", error.message);
    return data ? this.getOrder(data.id) : undefined;
  }
  async createOrder(input: any) { const out = await this.rpc<any>("ot_create_order", { p_scenario: input.scenarioId, p_merchant: input.merchantId, p_total: input.totalCents, p_items: input.items ?? [], p_key: input.idempotencyKey, p_hash: hashToken(JSON.stringify(input.requestFingerprint ?? input)) }); return { order: this.orderRow(out) }.order; }
  async settleRoundup(input: any) { return this.rpc<any>("ot_roundup", { p_order: input.orderId, p_succeeded: input.processorSucceeded, p_accept_roundup: input.acceptRoundup !== false, p_key: input.idempotencyKey, p_hash: hashToken(JSON.stringify(input)) }); }
  async createClaim(input: any) { const order = await this.getOrder(input.orderId); const claimId = randomUUID(); const token = deriveClaimToken(order.scenarioId, claimId, 1); const out = await this.rpc<any>("ot_create_claim", { p_order: input.orderId, p_claim: claimId, p_token_hash: hashToken(token), p_key: input.idempotencyKey, p_hash: hashToken(JSON.stringify(input)) }); const actualClaimId = out.claim_id; return { claimId: actualClaimId, token: deriveClaimToken(out.scenario_id, actualClaimId, 1), expiresAt: new Date(out.expires_at) }; }
  async getClaim(id: string): Promise<Claim> { const r: any = await this.one("claim_sessions", id, "CLAIM_NOT_FOUND"); return { id: r.id, scenarioId: r.scenario_id, orderId: r.order_id, tokenHash: r.token_hash, generation: r.generation, expiresAt: new Date(r.expires_at), consumedAt: r.consumed_at ? new Date(r.consumed_at) : undefined, cancelledAt: r.cancelled_at ? new Date(r.cancelled_at) : undefined, claimSessionExpiresAt: r.claim_session_expires_at ? new Date(r.claim_session_expires_at) : undefined }; }
  async exchangeClaimToken(token: string) { const r: any = await this.rpc("ot_exchange_claim", { p_token_hash: hashToken(token) }); return this.getClaim(r.claim_id); }
  async authorizeClaim(input: any): Promise<AuthorizeResult> { return this.rpc("ot_authorize", { p_claim: input.claimId, p_device_hash: input.deviceHash, p_amount: input.amountCents, p_key: input.idempotencyKey, p_hash: hashToken(JSON.stringify(input)) }); }
  async authorize(input: any) { const c: any = await this.rpc("ot_claim_by_token", { p_token_hash: hashToken(input.token) }); return this.authorizeClaim({ ...input, claimId: c.claim_id }); }
  async completeOrder(input: any): Promise<CompleteResult> { return this.rpc("ot_complete", { p_order: input.orderId, p_key: input.idempotencyKey, p_hash: hashToken(JSON.stringify(input)) }); }
  async failOrCancelOrder(input: any) { return this.rpc("ot_close", { p_order: input.orderId, p_reason: input.reason, p_key: input.idempotencyKey, p_hash: hashToken(JSON.stringify(input)) }); }
  async refundOrder(input: any): Promise<RefundResult> { return this.rpc("ot_refund", { p_order: input.orderId, p_requested: input.requestedCents, p_external_id: input.externalId, p_key: input.idempotencyKey, p_hash: hashToken(JSON.stringify(input)) }); }
  async settleReceivable(input: any) { return this.rpc("ot_settle", { p_receivable: input.receivableId, p_key: input.idempotencyKey, p_hash: hashToken(JSON.stringify(input)) }); }
  async repayDebt(input: any) { return this.rpc("ot_repay_debt", { p_debt: input.debtId, p_amount: input.amountCents, p_key: input.idempotencyKey, p_hash: hashToken(JSON.stringify(input)) }); }
  async availablePoolCents(id: string) { return Number(await this.rpc<number>("ot_available_pool", { p_scenario: id })); }
  async listLedger(id: string): Promise<LedgerEntry[]> { const { data, error } = await this.db.from("ledger_entries").select("*").eq("scenario_id", id); if (error) throw new DomainError("PERSISTENCE_ERROR", error.message); return (data ?? []).map((r: any) => ({ id: r.id, scenarioId: r.scenario_id, orderId: r.order_id, merchantId: r.merchant_id, kind: r.kind, amountCents: Number(r.amount_cents), createdAt: new Date(r.created_at) })); }
  async listReceivables(id: string): Promise<Receivable[]> { const { data, error } = await this.db.from("merchant_receivables").select("*").eq("scenario_id", id); if (error) throw new DomainError("PERSISTENCE_ERROR", error.message); return (data ?? []).map((r: any) => ({ id: r.id, scenarioId: r.scenario_id, orderId: r.order_id, merchantId: r.merchant_id, originalCents: Number(r.original_cents), reducedCents: Number(r.reduced_cents), settledCents: Number(r.settled_cents), status: r.status })); }
  async listDebts(id: string): Promise<MerchantDebt[]> { const { data, error } = await this.db.from("merchant_recovery_debts").select("*").eq("scenario_id", id); if (error) throw new DomainError("PERSISTENCE_ERROR", error.message); return (data ?? []).map((r: any) => ({ id: r.id, scenarioId: r.scenario_id, merchantId: r.merchant_id, orderId: r.order_id, amountCents: Number(r.amount_cents), recoveredCents: Number(r.recovered_cents) })); }
  async expireReservations() { return 0; }
  async rateLimit(key: string, limit: number, windowMs: number) { return this.rpc<boolean>("ot_rate_limit", { p_key: key, p_limit: limit, p_window_seconds: Math.ceil(windowMs / 1000) }); }
}
