import { describe, expect, it } from "vitest";
import { claimPresets } from "./claim-presets";

describe("claimPresets", () => {
  it("caps use all at the €5 per-order limit", () => {
    expect(claimPresets(1000, 900, 900).map((choice) => choice.amountCents)).toEqual([0, 125, 250, 375, 500]);
  });

  it("uses the smallest available limit", () => {
    expect(claimPresets(240, 1000, 500).map((choice) => choice.amountCents)).toEqual([0, 60, 120, 180, 240]);
  });

  it("rounds to cents and removes duplicate choices for small totals", () => {
    expect(claimPresets(3, 3, 500)).toEqual([
      { label: "None", amountCents: 0 },
      { label: "25%", amountCents: 1 },
      { label: "50%", amountCents: 2 },
      { label: "Use all", amountCents: 3 },
    ]);
  });

  it("offers only None when nothing is available", () => {
    expect(claimPresets(0, 280, 500)).toEqual([{ label: "None", amountCents: 0 }]);
  });
});
