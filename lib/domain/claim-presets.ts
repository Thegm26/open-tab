export type ClaimPreset = {
  label: string;
  amountCents: number;
};

/**
 * Build the small, predictable set of amounts a customer can choose.
 * Amounts are always whole cents and never exceed the server-side limits.
 */
export function claimPresets(availableCents: number, remainingCents: number, perOrderLimitCents: number): ClaimPreset[] {
  const maxCents = Math.max(0, Math.min(500, availableCents, remainingCents, perOrderLimitCents));
  const choices: ClaimPreset[] = [
    { label: "None", amountCents: 0 },
    { label: "25%", amountCents: Math.round(maxCents * 0.25) },
    { label: "50%", amountCents: Math.round(maxCents * 0.5) },
    { label: "75%", amountCents: Math.round(maxCents * 0.75) },
    { label: "Use all", amountCents: maxCents },
  ];

  const seen = new Set<number>();
  return choices.filter((choice) => {
    if (seen.has(choice.amountCents)) return false;
    seen.add(choice.amountCents);
    return true;
  });
}
