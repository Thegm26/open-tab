"use client";
import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { CATALOG } from "@/lib/domain/catalog";
import { claimPresets } from "@/lib/domain/claim-presets";
import { receiptSummary, type PaymentKind } from "@/lib/domain/receipt";

const money = (c = 0) => `€${(c / 100).toFixed(2)}`;
const roundUp = (total: number) => {
  const remainder = total % 50;
  return remainder === 0 ? 20 : 50 - remainder;
};
const products = {
  cafe: CATALOG.cafe.items.map((item) => ({
    name: item.name,
    sku: item.sku,
    price: item.priceCents,
  })),
  bakery: CATALOG.bakery.items.map((item) => ({
    name: item.name,
    sku: item.sku,
    price: item.priceCents,
  })),
} as const;
const names: Record<string, string> = {
  cafe: "Café Sol",
  bakery: "Bread & Butter Bakery",
};
const logos = {
  cafe: "/cafe-sol-logo.jpg",
  bakery: "/bread-butter-bakery-logo.jpg",
} as const;
const productIcons: Record<string, string> = { espresso: "☕", dinner: "🍽️", toast: "🍅", lemonade: "🍋", "flat-white": "🥛", "iced-coffee": "🧊", "orange-juice": "🍊", "chicken-salad": "🥗", "pasta-bowl": "🍝", cheesecake: "🍰", croissant: "🥐", lunch: "🥪", sourdough: "🍞", cookie: "🍪", baguette: "🥖", "rye-loaf": "🍞", "cinnamon-roll": "🌀", "veggie-focaccia": "🥬", "iced-tea": "🧋", "hot-chocolate": "☕" };
const key = () => crypto.randomUUID();
function csrfToken(scenarioId: string) {
  const name = `ot_csrf_${scenarioId}=`;
  const cookie = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(name));
  return cookie ? decodeURIComponent(cookie.slice(name.length)) : "";
}
type Order = {
  id: string;
  scenarioId: string;
  merchantId: string;
  totalCents: number;
  openTabCents: number;
  remainingTenderCents: number;
  status: string;
  refundedCents: number;
  customerTenderCents: number;
  items?: { sku: string; quantity: number; name: string; priceCents: number }[];
};
const orderStatusRank: Record<string, number> = {
  open: 0,
  authorized: 1,
  completed: 2,
  partially_refunded: 3,
  refunded: 4,
  cancelled: 2,
  failed: 2,
  payment_failed: 2,
  authorization_expired: 2,
};
function mergeOrder(previous: Order | undefined, next: Order): Order {
  // The terminal and status pollers can resolve out of order. Never let an
  // older in-flight response regress the same order's lifecycle state.
  if (previous?.id === next.id && (orderStatusRank[previous.status] ?? 0) > (orderStatusRank[next.status] ?? 0)) return previous;
  return next;
}
type Dash = {
  pool: { availableCents: number; settledCents: number };
  contributedCents: number;
  completedHelpedCount: number;
  scenario: { id: string; activated: boolean; expiresAt: string };
  ledger: {
    id: string;
    kind: string;
    amountCents: number;
    createdAt: string;
  }[];
  receivables: {
    id: string;
    originalCents: number;
    reducedCents: number;
    settledCents: number;
    status: string;
  }[];
  debts: { id: string; amountCents: number; recoveredCents: number }[];
};

export default function Home() {
  const pathname = usePathname();
  const isCheckout = pathname === "/checkout";
  const view = isCheckout ? "pos" : "dashboard";
  const routeMerchant = pathname === "/admin/bakery" ? "bakery" : "cafe";

  useEffect(() => {
    document.title = isCheckout ? "OpenTab / Client" : "OpenTab / Employee";
  }, [isCheckout]);
  const [merchant, setMerchant] = useState<"cafe" | "bakery">(routeMerchant);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [order, setOrder] = useState<Order>();
  const [contributionCents, setContributionCents] = useState(0);
  const [paymentKind, setPaymentKind] = useState<PaymentKind>();
  const [scenarioId, setScenarioId] = useState("");
  const [message, setMessage] = useState("");
  const [checkoutError, setCheckoutError] = useState("");
  const [availablePoolCents, setAvailablePoolCents] = useState(0);
  const [claim, setClaim] = useState<{ remainingCents: number; amountCents: number; presets: ReturnType<typeof claimPresets> }>();
  const [dashboard, setDashboard] = useState<Dash>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!isCheckout) setMerchant(routeMerchant);
  }, [isCheckout, routeMerchant]);
  const product = products[merchant][0];
  // Never label an aggregate legacy order with the first catalog SKU.
  const orderTitle = order?.items?.length === 1 ? order.items[0].name : "Order total";
  const cartTotal = Object.entries(cart).reduce((sum, [sku, quantity]) => sum + (products[merchant].find((item) => item.sku === sku)?.price ?? 0) * quantity, 0);
  const refresh = useCallback(async () => {
    if (!scenarioId) return;
    try {
      const response = await fetch(`/api/dashboard?scenarioId=${scenarioId}`, {
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "DASHBOARD_LOAD_FAILED");
      setDashboard(data);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Dashboard refresh failed.",
      );
    }
  }, [scenarioId]);
  useEffect(() => {
    if (!isCheckout) return;
    let active = true;
    const poll = async () => {
      const response = await fetch("/api/demo-terminal/current-order", { cache: "no-store" });
      if (!response.ok || !active) return;
      const data = await response.json() as { order: Order | null; availablePoolCents: number };
      setAvailablePoolCents(data.availablePoolCents);
      if (data.order) {
        setOrder((previous) => {
          if (previous?.id !== data.order!.id) {
            setContributionCents(0);
            setPaymentKind(undefined);
            setClaim(undefined);
          }
          return mergeOrder(previous, data.order!);
        });
        setScenarioId(data.order.scenarioId);
        if (data.order.merchantId === "cafe" || data.order.merchantId === "bakery") setMerchant(data.order.merchantId);
      }
    };
    poll();
    const timer = setInterval(poll, 1200);
    return () => { active = false; clearInterval(timer); };
  }, [isCheckout]);
  useEffect(() => {
    if (isCheckout) return;
    const storedScenario = sessionStorage.getItem("ot_active_scenario");
    if (storedScenario) setScenarioId(storedScenario);
  }, [isCheckout]);
  useEffect(() => {
    if (!isCheckout && scenarioId) refresh();
  }, [isCheckout, scenarioId, refresh]);
  useEffect(() => {
    if (!order || !scenarioId) return;
    let active = true;
    const poll = async () => {
      const r = await fetch(isCheckout ? `/api/demo-terminal/orders/${order.id}` : `/api/pos/orders/${order.id}/status`, {
        cache: "no-store",
      });
      if (!active) return;
      if (r.ok) {
        const data = await r.json() as { order: Order };
        if (!active) return;
        setOrder((previous) => mergeOrder(previous, data.order));
      }
      if (!isCheckout) refresh();
    };
    poll();
    const timer = setInterval(poll, 1500);
    return () => { active = false; clearInterval(timer); };
  }, [order?.id, scenarioId, refresh, isCheckout]);
  async function start() {
    setLoading(true);
    setCheckoutError("");
    setContributionCents(0);
    setPaymentKind(undefined);
    try {
      const bootstrap = async () => {
        let secret = sessionStorage.getItem("ot_demo_secret");
        let scenarioKey = sessionStorage.getItem("ot_demo_key");
        if (!secret) {
          const bytes = new Uint8Array(32);
          crypto.getRandomValues(bytes);
          secret = btoa(String.fromCharCode(...bytes));
          sessionStorage.setItem("ot_demo_secret", secret);
        }
        if (!scenarioKey) {
          scenarioKey = key();
          sessionStorage.setItem("ot_demo_key", scenarioKey);
        }
        return fetch("/api/demo-scenarios", {
          method: "POST",
          headers: { "x-demo-bootstrap": secret, "idempotency-key": scenarioKey },
        });
      };
      let s = await bootstrap();
      let sd = await s.json();
      if (!s.ok && sd.error === "BOOTSTRAP_EXPIRED") {
        sessionStorage.removeItem("ot_demo_secret");
        sessionStorage.removeItem("ot_demo_key");
        s = await bootstrap();
        sd = await s.json();
      }
      if (!s.ok) throw new Error(sd.error);
      setScenarioId(sd.scenario.id);
      const r = await fetch("/api/pos/orders", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key(),
          "x-csrf-token": csrfToken(sd.scenario.id),
        },
        body: JSON.stringify({
          scenarioId: sd.scenario.id,
          merchant,
          items: Object.entries(cart).map(([sku, quantity]) => ({ sku, quantity })),
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setOrder(d.order);
      setMessage(`Order created · ${money(d.order.totalCents)}.`);
      refresh();
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Could not start checkout.";
      setMessage(errorMessage);
      setCheckoutError(errorMessage);
    } finally {
      setLoading(false);
    }
  }
  async function action(path: string, body?: unknown) {
    if (!order || loading) return;
    setLoading(true);
    setMessage("Processing payment…");
    try {
      const terminalAction = isCheckout && (path === "checkout" || path === "round-up" || path === "complete");
      const r = await fetch(terminalAction ? `/api/demo-terminal/orders/${order.id}` : `/api/pos/orders/${order.id}/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key(),
          ...(terminalAction ? {} : { "x-csrf-token": csrfToken(scenarioId) }),
        },
        body: terminalAction ? JSON.stringify({ action: path, ...(body as object ?? {}) }) : body ? JSON.stringify(body) : undefined,
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "ORDER_UPDATE_FAILED");
      const nextContributionCents = Number(data.contributionCents ?? 0);
      setContributionCents(nextContributionCents);
      if (path === "round-up") setPaymentKind("roundup");
      else if (path === "checkout") setPaymentKind("exact");
      else if (path === "complete") setPaymentKind("assisted");
      const statusResponse = await fetch(`/api/pos/orders/${order.id}/status`, {
        cache: "no-store",
      });
      if (statusResponse.ok) {
        const data = await statusResponse.json() as { order: Order };
        setOrder((previous) => mergeOrder(previous, data.order));
      }
      setMessage(
        data.contributionCents
          ? `Round-up added ${money(data.contributionCents)} to the pool.`
          : "Order updated.",
      );
      refresh();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Order update failed.",
      );
    } finally {
      setLoading(false);
    }
  }

  function createNewOrder() {
    setOrder(undefined);
    setContributionCents(0);
    setPaymentKind(undefined);
    setCheckoutError("");
    setMessage("");
    setClaim(undefined);
    setCart({});
  }
  async function startOpenTab() {
    if (!order || loading) return;
    setLoading(true);
    setMessage("Opening Open Tab…");
    try {
      const terminalAction = isCheckout;
      const r = await fetch(terminalAction ? `/api/demo-terminal/orders/${order.id}` : `/api/pos/orders/${order.id}/claim-session`, {
        method: "POST",
        headers: {
          "idempotency-key": key(),
          ...(terminalAction ? {} : { "x-csrf-token": csrfToken(scenarioId) }),
        },
        body: terminalAction ? JSON.stringify({ action: "claim-session" }) : undefined,
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "QR_CREATE_FAILED");
      const exchanged = await fetch("/api/claims/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: d.token }) });
      if (!exchanged.ok) throw new Error((await exchanged.json()).error ?? "CLAIM_EXCHANGE_FAILED");
      const session = await fetch("/api/claims/session", { cache: "no-store" });
      const sessionData = await session.json();
      if (!session.ok) throw new Error(sessionData.error ?? "CLAIM_SESSION_FAILED");
      const inspect = await fetch("/api/claims/inspect", { method: "POST" });
      const inspectData = await inspect.json();
      if (!inspect.ok) throw new Error(inspectData.error ?? "CLAIM_INSPECT_FAILED");
      const max = Math.min(sessionData.order.remainingTenderCents, availablePoolCents, inspectData.limits.perOrderCents);
      setClaim({ remainingCents: max, amountCents: 0, presets: claimPresets(availablePoolCents, sessionData.order.remainingTenderCents, inspectData.limits.perOrderCents) });
      setMessage("");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not open Open Tab.",
      );
    } finally {
      setLoading(false);
    }
  }

  const roundup = order
    ? roundUp(order.totalCents)
    : roundUp(product.price);
  const paid = order?.status === "completed";
  const receipt = order && paid && paymentKind ? receiptSummary(order, paymentKind, contributionCents) : undefined;
  const activeOrder = Boolean(order && !["completed", "cancelled", "failed", "refunded"].includes(order.status));
  const customerOrderSummary = order ? (
    <div className="customer-order-summary">
      {order.items?.length ? order.items.map((item) => <div className="customer-order-line" key={item.sku}>
        <span className="customer-item-name">{item.name}</span>
        <span className="customer-quantity">{item.quantity}</span>
        <strong className="customer-line-price">{money(item.priceCents * item.quantity)}</strong>
      </div>) : <div className="customer-order-line"><span className="customer-item-name">Order total</span><span className="customer-quantity">—</span><strong className="customer-line-price">{money(order.totalCents)}</strong></div>}
      <p className="payment-summary">Total due <strong>{money(order.totalCents)}</strong></p>
    </div>
  ) : null;
  return (
    <main className="shell">
      {view === "pos" ? (
        <section
          id="counter-panel"
          role="tabpanel"
          aria-labelledby="counter-tab"
          className="workspace"
        >
          <div className="pos-panel card">
            <h1 className="card-view-title">Customer Checkout</h1>
            {order && <div className="checkout-brand">
              <Image className="checkout-logo" src={logos[merchant]} alt={`${names[merchant]} logo`} width={176} height={176} priority />
            </div>}
            {paid ? (
                <div className="receipt">
                    <div className="approved-mark">✓</div>
                  <h3>Paid {money(receipt?.paidCents ?? order.customerTenderCents)}</h3>
                  <div className="receipt-breakdown">
                    <span>
                      Purchase <strong>{money(order.totalCents)}</strong>
                    </span>
                    {receipt?.assistanceCents ? <span>Open Tab covered <strong>{money(receipt.assistanceCents)}</strong></span> : null}
                    {receipt?.contributionCents ? <span>Open Tab contribution <strong>{money(receipt.contributionCents)}</strong></span> : null}
                    {receipt?.assistanceCents ? <span>Customer paid <strong>{money(receipt.customerPaidCents)}</strong></span> : null}
                  </div>
                  <p>
                    {receipt?.assistanceCents
                      ? <>Open Tab helped cover {money(receipt.assistanceCents)} of your purchase.</>
                      : receipt?.contributionCents
                        ? <>Thank you for helping each other <span role="img" aria-label="heart">♥</span></>
                        : "Payment received."}
                  </p>
                </div>
              )
            : !order ? <p className="muted terminal-waiting">Waiting for the employee to create a checkout…</p> : claim ? (
              <>{customerOrderSummary}<div className="inline-claim">
                <div className="inline-claim-heading"><div><h3>Use Open Tab</h3><p>Choose how much Open Tab covers.</p></div><strong>{money(claim.remainingCents)} available</strong></div>
                <div className="claim-presets" role="group" aria-label="Choose Open Tab amount">
                  {claim.presets.map((preset) => (
                    <button
                      key={preset.amountCents}
                      type="button"
                      className={`claim-preset ${claim.amountCents === preset.amountCents ? "selected" : ""}`}
                      aria-pressed={claim.amountCents === preset.amountCents}
                      onClick={() => preset.amountCents === 0 ? (setClaim(undefined), setMessage("Open Tab skipped.")) : setClaim({ ...claim, amountCents: preset.amountCents })}
                    >
                      <span>{preset.label}</span><strong>{money(preset.amountCents)}</strong>
                    </button>
                  ))}
                </div>
                <button className="button primary full" disabled={loading || claim.amountCents < 1} onClick={async () => { setLoading(true); setMessage("Applying Open Tab…"); try { const response = await fetch("/api/claims/authorize", { method: "POST", headers: { "content-type": "application/json", origin: location.origin, "idempotency-key": key() }, body: JSON.stringify({ amountCents: claim.amountCents }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "OPEN_TAB_FAILED"); const status = await fetch(`/api/demo-terminal/orders/${order.id}`, { cache: "no-store" }); if (status.ok) setOrder((await status.json()).order); setClaim(undefined); setMessage(`Open Tab covered ${money(data.amountCents)}.`); } catch (error) { setMessage(error instanceof Error ? error.message : "Open Tab failed."); } finally { setLoading(false); } }}>Apply Open Tab · {money(claim.amountCents)}</button>
              </div></>
            ) : order.status === "authorized" ? (
              <>{customerOrderSummary}<div className="payment-choice">
                <p>
                  <strong>
                    {money(order.openTabCents)} covered by Open Tab.
                  </strong>{" "}
                  Collect the remaining {money(order.remainingTenderCents)}.
                </p>
                <button
                  className="button primary full"
                  onClick={() => action("complete")}
                  disabled={loading}
                >
                  {loading
                    ? "Processing…"
                    : `Pay remaining ${money(order.remainingTenderCents)}`}
                </button>
              </div></>
            ) : (
              <div className="payment-choice">
                {customerOrderSummary}
                {roundup > 0 && (
                  <div className="payment-tiles" aria-label="Choose payment amount">
                    <button
                      className="payment-tile exact-tile"
                      disabled={loading}
                      onClick={() => action("checkout", { succeeded: true })}
                    >
                      <svg className="payment-tile-icon" viewBox="0 0 48 48" aria-hidden="true"><rect x="5" y="10" width="38" height="28" rx="4" fill="none" stroke="currentColor" strokeWidth="3"/><path d="M5 19h38M11 30h9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/></svg>
                      <span className="payment-tile-title">Pay exact amount</span>
                      <strong className="payment-tile-amount">{money(order.totalCents)}</strong>
                      <span className="payment-tile-hint">No contribution</span>
                    </button>
                    <button
                      className="payment-tile roundup-tile"
                      disabled={loading}
                      onClick={() => action("round-up", { succeeded: true, acceptRoundup: true })}
                    >
                      <svg className="payment-tile-icon" viewBox="0 0 48 48" aria-hidden="true"><path d="M24 38S9 29.5 9 19.5C9 14.8 12.5 11 17 11c3.1 0 5.5 1.8 7 4.2 1.5-2.4 3.9-4.2 7-4.2 4.5 0 8 3.8 8 8.5C39 29.5 24 38 24 38Z" fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round"/></svg>
                      <span className="payment-tile-title">{order.totalCents % 50 === 0 ? "Add to Open Tab" : "Round up to"}</span>
                      <strong className="payment-tile-amount">{money(order.totalCents + roundup)}</strong>
                      <span className="payment-tile-hint">{order.totalCents % 50 === 0 ? <>Pay {money(order.totalCents + roundup)} · <b>{money(roundup)}</b> goes to Open Tab</> : <><b>{money(roundup)}</b> goes to Open Tab</>}</span>
                    </button>
                  </div>
                )}
                {roundup === 0 && (
                  <button
                    className="button primary full"
                    disabled={loading}
                    onClick={() => action("checkout", { succeeded: true })}
                  >
                    {loading ? "Processing…" : `Pay ${money(order.totalCents)}`}
                  </button>
                )}
                <div className="open-tab-availability">Open Tab available <strong>{money(availablePoolCents)}</strong></div>
                <button
                  className="open-tab-link"
                  onClick={startOpenTab}
                  disabled={loading || availablePoolCents < 1}
                >
                  {availablePoolCents > 0 ? "Use Open Tab" : "No funds available"}
                </button>
              </div>
            )}{" "}
            {order && !paid && (
              <div className="order-state">
                <span className={`status-dot ${order.status}`} />{" "}
                <span>{message}</span>
              </div>
            )}
          </div>
        </section>
      ) : (
        <>{paid ? <section className="admin-order card paid-confirmation" aria-live="polite">
          <h1 className="card-view-title">Employee View / Control Panel</h1>
          <Image className="merchant-route-logo card-merchant-logo" src={logos[merchant]} alt="" width={132} height={132} priority />
          <div className="approved-mark">✓</div>
          <h2>PAID</h2>
          <p className="paid-amount">{money(order.totalCents)}</p>
          <button className="button primary full" onClick={createNewOrder}>Create new order</button>
        </section> : <section className="admin-order card"><h1 className="card-view-title">Employee View / Control Panel</h1><Image className="merchant-route-logo card-merchant-logo" src={logos[merchant]} alt="" width={132} height={132} priority /><div className="card-heading"><div><h2>Order</h2></div></div><div className="product-picker" aria-label="Choose product">{products[merchant].map((item) => <button type="button" className="product-tile" key={item.sku} onClick={() => { if (!activeOrder) setCart((items) => ({ ...items, [item.sku]: (items[item.sku] ?? 0) + 1 })); }} disabled={activeOrder}><span className="product-icon" aria-hidden="true">{productIcons[item.sku]}</span><span>{item.name}</span><strong>{money(item.price)}</strong></button>)}</div>{Object.entries(cart).map(([sku, quantity]) => { const item = products[merchant].find((candidate) => candidate.sku === sku)!; return <div className="cart-line" key={sku}><span className="cart-item-name">{item.name}</span><span className="cart-quantity">{quantity}</span><strong className="cart-price">{money(item.price * quantity)}</strong><button type="button" className="icon-button" aria-label={`Remove one ${item.name}`} onClick={() => setCart((items) => { const next = { ...items }; if (quantity <= 1) delete next[sku]; else next[sku] = quantity - 1; return next; })}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12M9 7V5h6v2m-8 0 1 12h6l1-12M10 10v6m4-6v6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></button></div>; })}{!activeOrder && Object.keys(cart).length > 0 && <button className="button primary full" onClick={start} disabled={loading}>{loading ? "Opening…" : `Create checkout · ${money(cartTotal)}`}<span>→</span></button>}{checkoutError && <p className="checkout-error" role="alert">{checkoutError}</p>}{order && <div className={`order-state order-state-${order.status}`}><span className={`status-dot ${order.status}`} /><strong>{order.status === "open" ? "PENDING" : order.status === "completed" ? "PAID" : order.status.replaceAll("_", " ").toUpperCase()}</strong><span className="mono">{money(order.totalCents)}</span></div>}</section>}<Dashboard
          dashboard={dashboard}
          refresh={refresh}
          notify={setMessage}
        /></>
      )}
      <p className="sr-status" role="status">
        {message}
      </p>
    </main>
  );
}

function Dashboard({
  dashboard,
  refresh,
  notify,
}: {
  dashboard?: Dash;
  refresh: () => void;
  notify: (message: string) => void;
}) {
  const activity = dashboard?.ledger.slice().reverse() ?? [];
  const activityPageSize = 5;
  const activityPageCount = Math.max(1, Math.ceil(activity.length / activityPageSize));
  const [activityPage, setActivityPage] = useState(1);
  const activitySignature = activity.map((item) => `${item.id}:${item.createdAt}`).join("|");
  useEffect(() => {
    setActivityPage(1);
  }, [activitySignature]);
  useEffect(() => {
    setActivityPage((page) => Math.min(page, activityPageCount));
  }, [activityPageCount]);
  const visibleActivity = activity.slice((activityPage - 1) * activityPageSize, activityPage * activityPageSize);
  if (!dashboard) return null;
  const currentDashboard = dashboard;
  const outstandingReceivables = currentDashboard.receivables.filter((entry) => entry.status === "unsettled" && entry.originalCents - entry.reducedCents - entry.settledCents > 0);
  async function settle(id: string) {
    try {
      const response = await fetch(
        `/api/merchant/receivables/${id}/settle?scenarioId=${currentDashboard.scenario.id}`,
        {
          method: "POST",
          headers: {
            "idempotency-key": key(),
            "x-csrf-token": csrfToken(currentDashboard.scenario.id),
          },
        },
      );
      if (!response.ok)
        throw new Error((await response.json()).error ?? "SETTLEMENT_FAILED");
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "SETTLEMENT_FAILED");
      refresh();
    }
  }
  async function repay(id: string, amountCents: number) {
    try {
      const response = await fetch(
        `/api/merchant/debts/${id}/repay?scenarioId=${currentDashboard.scenario.id}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": key(),
            "x-csrf-token":
              csrfToken(currentDashboard.scenario.id),
          },
          body: JSON.stringify({ amountCents }),
        },
      );
      if (!response.ok)
        throw new Error((await response.json()).error ?? "RECOVERY_FAILED");
      refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "RECOVERY_FAILED");
      refresh();
    }
  }
  return (
    <div
      id="dashboard-panel"
      role="tabpanel"
      aria-labelledby="dashboard-tab"
      className="dashboard"
    >
      <div className="metrics">
        <Metric
          label="Available to help"
          value={money(dashboard.pool.availableCents)}
          tone="green"
        />
        <Metric
          label="Contributed"
          value={money(dashboard.contributedCents)}
        />
        <Metric
          label="People helped"
          value={String(dashboard.completedHelpedCount)}
        />
      </div>
      <div className="dash-grid">
        <section className="card">
          <div className="card-heading">
            <div>
              <h2>Activity</h2>
            </div>
            <button className="text-button" onClick={refresh} aria-label="Refresh activity">↻</button>
          </div>
          {activity.length ? (
            <div className="activity">
              {visibleActivity.map((item) => (
                <div className="activity-row" key={item.id}>
                  <span
                    className={`activity-icon ${item.amountCents < 0 ? "debit" : "credit"}`}
                  >
                    {item.amountCents < 0 ? "−" : "+"}
                  </span>
                  <div>
                    <strong>{item.kind.replaceAll("_", " ")}</strong>
                    <small>
                      {new Date(item.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </small>
                  </div>
                  <b className={item.amountCents < 0 ? "negative" : "positive"}>
                    {item.amountCents > 0 ? "+" : ""}
                    {money(item.amountCents)}
                  </b>
                </div>
              ))}
              {activityPageCount > 1 && <div className="activity-pagination" aria-label="Activity pages">
                <button className="text-button" type="button" onClick={() => setActivityPage((page) => page - 1)} disabled={activityPage === 1}>Previous</button>
                <span>Page {activityPage} of {activityPageCount}</span>
                <button className="text-button" type="button" onClick={() => setActivityPage((page) => page + 1)} disabled={activityPage === activityPageCount}>Next</button>
              </div>}
            </div>
          ) : (
            <p className="muted">Your first checkout will appear here.</p>
          )}
        </section>
      </div>
      {(outstandingReceivables.length > 0 || dashboard.debts.length > 0) && <section className="card settlement-card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">SETTLEMENT & RECOVERY</p>
            <h2>Merchant receivables</h2>
          </div>
          <span className="muted">
            {dashboard.completedHelpedCount} assisted purchases
          </span>
        </div>
        {outstandingReceivables.map((receivable) => (
            <div className="settlement-row" key={receivable.id}>
              <div>
                <strong>Purchase {receivable.id.slice(0, 6)}</strong>
                <small>
                  {receivable.status.replaceAll("_", " ")} ·{" "}
                    <span>Open Tab owes merchant {money(
                    receivable.originalCents -
                      receivable.reducedCents -
                      receivable.settledCents,
                  )}</span>
                </small>
              </div>
              <button
                className="button secondary"
                disabled={receivable.status !== "unsettled"}
                onClick={() => settle(receivable.id)}
              >
                Settle
              </button>
            </div>
          ))}
        {dashboard.debts.length > 0 && (
          <>
            <div className="card-heading recovery-heading">
              <div>
                <p className="eyebrow">RECOVERY DEBT</p>
                <h2>Restore funds when ready</h2>
              </div>
            </div>
            {dashboard.debts.map((debt) => (
              <div className="settlement-row" key={debt.id}>
                <div>
                  <strong>Debt {debt.id.slice(0, 6)}</strong>
                  <small>
                    {money(debt.amountCents - debt.recoveredCents)} outstanding
                  </small>
                </div>
                <button
                  className="button secondary"
                  disabled={debt.recoveredCents >= debt.amountCents}
                  onClick={() =>
                    repay(debt.id, debt.amountCents - debt.recoveredCents)
                  }
                >
                  Repay
                </button>
              </div>
            ))}
          </>
        )}
      </section>}
    </div>
  );
}
function Metric({
  label,
  value,
  tone = "",
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
