import { describe, expect, it } from "vitest";
import { CATALOG, canonicalItems, totalForItems } from "./catalog";

describe("catalog/server order parity", () => {
  it("accepts every visible merchant product with its canonical price", () => {
    for (const catalog of Object.values(CATALOG)) {
      for (const item of catalog.items) {
        expect(canonicalItems(catalog === CATALOG.cafe ? "cafe" : "bakery", [{ sku: item.sku, quantity: 1 }])).toEqual([{ sku: item.sku, quantity: 1 }]);
        expect(totalForItems(catalog === CATALOG.cafe ? "cafe" : "bakery", [{ sku: item.sku, quantity: 1 }])).toBe(item.priceCents);
      }
    }
  });

  it("retains the judged €7.80 and €4.50 demo totals", () => {
    expect(totalForItems("cafe", [{ sku: "dinner", quantity: 1 }])).toBe(780);
    expect(totalForItems("bakery", [{ sku: "lunch", quantity: 1 }])).toBe(450);
  });
});
