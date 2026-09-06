export type MerchantSlug = "cafe" | "bakery";

export const CATALOG: Record<MerchantSlug, { name: string; items: readonly { sku: string; name: string; priceCents: number }[] }> = {
  cafe: { name: "Café Sol", items: [
    { sku: "espresso", name: "Espresso", priceCents: 280 }, { sku: "dinner", name: "Dinner plate", priceCents: 780 }, { sku: "toast", name: "Tomato toast", priceCents: 500 }, { sku: "lemonade", name: "Lemonade", priceCents: 250 },
    { sku: "flat-white", name: "Flat white", priceCents: 390 }, { sku: "iced-coffee", name: "Iced coffee", priceCents: 420 }, { sku: "orange-juice", name: "Fresh orange juice", priceCents: 450 },
    { sku: "chicken-salad", name: "Chicken salad", priceCents: 980 }, { sku: "pasta-bowl", name: "Pasta bowl", priceCents: 1050 },
    { sku: "cheesecake", name: "Cheesecake slice", priceCents: 520 },
  ] },
  bakery: { name: "Bread & Butter Bakery", items: [
    { sku: "croissant", name: "Butter croissant", priceCents: 180 }, { sku: "lunch", name: "Lunch basket", priceCents: 450 }, { sku: "sourdough", name: "Sourdough loaf", priceCents: 450 }, { sku: "cookie", name: "Sea-salt cookie", priceCents: 250 },
    { sku: "baguette", name: "French baguette", priceCents: 280 }, { sku: "rye-loaf", name: "Rye loaf", priceCents: 480 }, { sku: "cinnamon-roll", name: "Cinnamon roll", priceCents: 320 },
    { sku: "veggie-focaccia", name: "Veggie focaccia", priceCents: 650 }, { sku: "iced-tea", name: "Iced tea", priceCents: 300 }, { sku: "hot-chocolate", name: "Hot chocolate", priceCents: 390 },
  ] },
};

export function isMerchantSlug(value: string): value is MerchantSlug { return value === "cafe" || value === "bakery"; }

/** Normalize a basket so idempotency is stable across item ordering/duplicate lines. */
export function canonicalItems(merchant: MerchantSlug, items: unknown): { sku: string; quantity: number }[] {
  if (!Array.isArray(items) || items.length === 0) throw new Error("INVALID_CATALOG_ITEMS");
  const quantities = new Map<string, number>();
  for (const entry of items) {
    if (!entry || typeof entry !== "object") throw new Error("INVALID_CATALOG_ITEMS");
    const { sku, quantity } = entry as { sku?: unknown; quantity?: unknown };
    if (typeof sku !== "string" || typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw new Error("INVALID_CATALOG_ITEMS");
    if (!CATALOG[merchant].items.some((item) => item.sku === sku)) throw new Error("INVALID_CATALOG_ITEMS");
    const next = (quantities.get(sku) ?? 0) + quantity;
    if (next > 20) throw new Error("INVALID_CATALOG_ITEMS");
    quantities.set(sku, next);
  }
  return [...quantities].sort(([left], [right]) => left.localeCompare(right)).map(([sku, quantity]) => ({ sku, quantity }));
}

/** The browser supplies product selections, but totals always come from this catalog. */
export function totalForItems(merchant: MerchantSlug, items: unknown): number {
  return canonicalItems(merchant, items).reduce((total, entry) => total + CATALOG[merchant].items.find((item) => item.sku === entry.sku)!.priceCents * entry.quantity, 0);
}
