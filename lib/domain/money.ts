import { DomainError } from "./types";

export const ROUNDING_INCREMENT_CENTS = 50;
export const ALLOWED_ROUNDUP_CONTRIBUTION_CENTS = [10, 20, 50, 100] as const;
export type RoundupContributionCents = (typeof ALLOWED_ROUNDUP_CONTRIBUTION_CENTS)[number];

export function assertCents(value: number, name = "amountCents"): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new DomainError("INVALID_AMOUNT", `${name} must be a non-negative integer cents value`);
}

export function assertRoundupContributionCents(value: number): asserts value is RoundupContributionCents {
  if (!ALLOWED_ROUNDUP_CONTRIBUTION_CENTS.includes(value as RoundupContributionCents)) {
    throw new DomainError("INVALID_ROUNDUP_CONTRIBUTION");
  }
}

export function roundUpContributionCents(totalCents: number, fixedContributionCents: RoundupContributionCents = 20): number {
  assertCents(totalCents, "totalCents");
  assertRoundupContributionCents(fixedContributionCents);
  const centsIntoEuro = totalCents % 100;
  return centsIntoEuro === 0 || centsIntoEuro === 50
    ? fixedContributionCents
    : 100 - centsIntoEuro;
}

export function formatEur(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new DomainError("INVALID_AMOUNT");
  return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(cents / 100);
}
