"use client";
import { useEffect, useState } from "react";

const money = (c: number) => `€${(c / 100).toFixed(2)}`;
export default function ClaimPage() {
  const [info, setInfo] = useState<{ id: string; merchant: string; total: number; remaining: number }>();
  const [amount, setAmount] = useState(100); const [message, setMessage] = useState("Loading claim…");
  useEffect(() => {
    // Remove the bearer fragment before any asynchronous request or refresh.
    const token = location.hash.slice(1); history.replaceState(null, "", "/claim");
    const load = async () => {
      if (token) {
        const exchanged = await fetch("/api/claims/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
        if (!exchanged.ok) throw new Error((await exchanged.json()).error);
      }
      const response = await fetch("/api/claims/session", { cache: "no-store" });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      setInfo({ id: data.claim.id, merchant: "Participating merchant", total: data.order.totalCents, remaining: data.order.remainingTenderCents }); setAmount(Math.min(100, data.order.remainingTenderCents)); setMessage("");
      return data.order;
    };
    let timer: ReturnType<typeof setInterval> | undefined; let active = true;
    load().then(() => { if (!active) return; timer = setInterval(async () => { const response = await fetch("/api/claims/session", { cache: "no-store" }); if (!response.ok) return; const data = await response.json(); setInfo(current => current ? { ...current, remaining: data.order.remainingTenderCents } : current); if (data.order.status !== "open") setMessage(`Order status: ${data.order.status}.`); }, 2000); }).catch((error: Error) => { if (active) setMessage(error.message); });
    return () => { active = false; if (timer) clearInterval(timer); };
  }, []);
  async function authorize() {
    const response = await fetch("/api/claims/authorize", { method: "POST", headers: { "content-type": "application/json", origin: location.origin, "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ amountCents: amount }) });
    const data = await response.json(); setMessage(response.ok ? `Approved ${money(data.amountCents)}. Return to the counter.` : data.error);
  }
  return <main><p>SIMULATED PAYMENTS</p><h1>{info?.merchant ?? "Open Tab"}</h1>{info ? <><p>Purchase: {money(info.total)} · customer pays {money(info.remaining)}</p><label>Pool amount (cents) <input type="number" min="1" value={amount} onChange={event => setAmount(Number(event.target.value))} /></label><button onClick={authorize}>Authorize {money(amount)}</button></> : null}<p role="status">{message}</p></main>;
}
