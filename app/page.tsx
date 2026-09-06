"use client";
import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { CATALOG } from "@/lib/domain/catalog";

const money = (c = 0) => `€${(c / 100).toFixed(2)}`;
const roundUp = (total: number, fixed: number) => {
  const centsIntoEuro = total % 100;
  return centsIntoEuro === 0 || centsIntoEuro === 50 ? fixed : 100 - centsIntoEuro;
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
  totalCents: number;
  openTabCents: number;
  remainingTenderCents: number;
  status: string;
  refundedCents: number;
  customerTenderCents: number;
  roundupContributionCents: number;
};
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
  const [merchant, setMerchant] = useState<"cafe" | "bakery">("cafe");
  const [merchantRoundup, setMerchantRoundup] = useState<Record<"cafe" | "bakery", number>>({ cafe: 20, bakery: 20 });
  const [productIndex, setProductIndex] = useState(0);
  const [order, setOrder] = useState<Order>();
  const [contributionCents, setContributionCents] = useState(0);
  const [scenarioId, setScenarioId] = useState("");
  const [message, setMessage] = useState("Ready for a new checkout.");
  const [checkoutError, setCheckoutError] = useState("");
  const [qr, setQr] = useState("");
  const [dashboard, setDashboard] = useState<Dash>();
  const [loading, setLoading] = useState(false);
  const [restoredOrder, setRestoredOrder] = useState(false);
  const product = products[merchant][productIndex];
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
    if (!isCheckout || restoredOrder) return;
    const orderId = new URLSearchParams(location.search).get("orderId") ?? sessionStorage.getItem("ot_active_order");
    const storedScenario = sessionStorage.getItem("ot_active_scenario");
    if (!orderId || !storedScenario) return;
    setScenarioId(storedScenario);
    fetch(`/api/pos/orders/${orderId}/status`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("ACTIVE_ORDER_NOT_FOUND");
        const data = await response.json();
        setOrder(data.order);
        setRestoredOrder(true);
      })
      .catch(() => {
        sessionStorage.removeItem("ot_active_order");
        sessionStorage.removeItem("ot_active_scenario");
      });
  }, [isCheckout, restoredOrder]);
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
    const poll = async () => {
      const r = await fetch(`/api/pos/orders/${order.id}/status`, {
        cache: "no-store",
      });
      if (r.ok) setOrder((await r.json()).order);
      refresh();
    };
    poll();
    const timer = setInterval(poll, 1500);
    return () => clearInterval(timer);
  }, [order?.id, scenarioId, refresh]);
  async function start() {
    setLoading(true);
    setCheckoutError("");
    setContributionCents(0);
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
          roundupContributionCents: merchantRoundup[merchant],
          items: [{ sku: product.sku, quantity: 1 }],
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setOrder(d.order);
      sessionStorage.setItem("ot_active_order", d.order.id);
      sessionStorage.setItem("ot_active_scenario", sd.scenario.id);
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
      const r = await fetch(`/api/pos/orders/${order.id}/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key(),
          "x-csrf-token":
            csrfToken(scenarioId),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "ORDER_UPDATE_FAILED");
      setContributionCents(Number(data.contributionCents ?? 0));
      const statusResponse = await fetch(`/api/pos/orders/${order.id}/status`, {
        cache: "no-store",
      });
      if (statusResponse.ok) setOrder((await statusResponse.json()).order);
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
  async function createQr() {
    if (!order || loading) return;
    setLoading(true);
    setMessage("Preparing claim QR…");
    try {
      const r = await fetch(`/api/pos/orders/${order.id}/claim-session`, {
        method: "POST",
        headers: {
          "idempotency-key": key(),
          "x-csrf-token":
            csrfToken(scenarioId),
        },
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "QR_CREATE_FAILED");
      setQr(`${location.origin}${d.claimUrl}`);
      setMessage("Claim QR is ready to scan.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not create claim QR.",
      );
    } finally {
      setLoading(false);
    }
  }

  const roundup = order
    ? roundUp(order.totalCents, order.roundupContributionCents)
    : roundUp(product.price, merchantRoundup[merchant]);
  const paid = order?.status === "completed";
  return (
    <main className="shell">
      <header className="topbar">
        <div className="merchant-control">
          <span>{isCheckout ? "Customer checkout" : "Employee View"}</span>
          {isCheckout && <a className="button ghost" href="/admin">Employee View</a>}
          {!isCheckout && order && <a className="button ghost" href={`/checkout?orderId=${encodeURIComponent(order.id)}`} target="_blank" rel="noreferrer">Customer View</a>}
        </div>
      </header>
      {view === "pos" ? (
        <section
          id="counter-panel"
          role="tabpanel"
          aria-labelledby="counter-tab"
          className="workspace"
        >
          <div className="pos-panel card">
            {order && <div className="checkout-brand">
              <Image className="checkout-logo" src={logos[merchant]} alt={`${names[merchant]} logo`} width={176} height={176} priority />
            </div>}
            {order && (paid || qr || order.status === "authorized") && (
              <div className="card-heading">
                <div>
                  <h2>{product.name}</h2>
                </div>
                <span className="state-badge">{money(order.totalCents)}</span>
              </div>
            )}
            {paid ? (
                <div className="receipt">
                    <div className="approved-mark">✓</div>
                  <h3>Paid {money(order.totalCents + contributionCents)}</h3>
                  <div className="receipt-breakdown">
                    <span>
                      Purchase <strong>{money(order.totalCents)}</strong>
                    </span>
                    <span>
                      Open Tab contribution{" "}
                      <strong>{money(contributionCents)}</strong>
                    </span>
                  </div>
                  <p>
                    {contributionCents
                      ? <>Thank you for helping each other <span role="img" aria-label="heart">♥</span></>
                      : "Payment received."}
                  </p>
                </div>
              )
            : !order ? null : qr ? (
              <div className="qr-box">
                <QRCodeSVG
                  value={qr}
                  size={216}
                  includeMargin
                  role="img"
                  aria-label="Open Tab claim QR code"
                />
                <div>
                  <h3>Scan to use Open Tab</h3>
                  <p>
                    Show this QR code to the customer. We’ll update when they
                    authorize help.
                  </p>
                  <a href={qr}>Open on another device ↗</a>
                </div>
              </div>
            ) : order.status === "authorized" ? (
              <div className="payment-choice">
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
              </div>
            ) : (
              <div className="payment-choice">
                <div className="customer-order-summary">
                  <div className="customer-order-line">
                    <span>{product.name}</span>
                    <strong>{money(order.totalCents)}</strong>
                  </div>
                  <p className="payment-summary">
                    Total due <strong>{money(order.totalCents)}</strong>
                  </p>
                </div>
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
                      <span className="payment-tile-title">Round up to</span>
                      <strong className="payment-tile-amount">{money(order.totalCents + roundup)}</strong>
                      <span className="payment-tile-hint"><b>{money(roundup)}</b> goes to Open Tab</span>
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
                <button
                  className="open-tab-link"
                  onClick={createQr}
                  disabled={loading}
                >
                  Use Open Tab
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
        <><section className="admin-order card"><div className="card-heading"><div><h2>Order</h2></div></div><label className="pos-label">Merchant<select className="company-selector" aria-label="Merchant" value={merchant} onChange={(e) => { setMerchant(e.target.value as "cafe" | "bakery"); setProductIndex(0); }}><option value="cafe">Café Sol</option><option value="bakery">Bread &amp; Butter Bakery</option></select></label><label className="pos-label">Product<select value={productIndex} onChange={(e) => setProductIndex(Number(e.target.value))}>{products[merchant].map((item, index) => <option key={item.sku} value={index}>{item.name}</option>)}</select></label><div className="order-preview"><span>{product.name}</span><strong>{money(product.price)}</strong></div><button className="button primary full" onClick={start} disabled={loading}>{loading ? "Opening…" : `Create checkout · ${money(product.price)}`}<span>→</span></button>{checkoutError && <p className="checkout-error" role="alert">{checkoutError}</p>}</section><section className="merchant-settings card"><div className="card-heading"><div><p className="eyebrow">{names[merchant]}</p><h2>Merchant settings</h2></div></div><label className="pos-label">Default contribution<select aria-label={`Default contribution for ${names[merchant]}`} value={merchantRoundup[merchant]} onChange={(e) => setMerchantRoundup((current) => ({ ...current, [merchant]: Number(e.target.value) }))}><option value={10}>€0.10</option><option value={20}>€0.20</option><option value={50}>€0.50</option><option value={100}>€1.00</option></select></label></section><Dashboard
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
  if (!dashboard) return null;
  const currentDashboard = dashboard;
  const activity = currentDashboard.ledger.slice().reverse().slice(0, 6);
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
              {activity.map((item) => (
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
            </div>
          ) : (
            <p className="muted">Your first checkout will appear here.</p>
          )}
        </section>
      </div>
      {(dashboard.receivables.length > 0 || dashboard.debts.length > 0) && <section className="card settlement-card">
        <div className="card-heading">
          <div>
            <p className="eyebrow">SETTLEMENT & RECOVERY</p>
            <h2>Merchant receivables</h2>
          </div>
          <span className="muted">
            {dashboard.completedHelpedCount} assisted purchases
          </span>
        </div>
        {dashboard.receivables.map((receivable) => (
            <div className="settlement-row" key={receivable.id}>
              <div>
                <strong>Purchase {receivable.id.slice(0, 6)}</strong>
                <small>
                  {receivable.status.replaceAll("_", " ")} ·{" "}
                  {money(
                    receivable.originalCents -
                      receivable.reducedCents -
                      receivable.settledCents,
                  )}{" "}
                  payable
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
