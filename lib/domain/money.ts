import { DomainError } from "./types";

export const ROUNDING_INCREMENT_CENTS = 50;

export function assertCents(value: number, name = "amountCents"): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new DomainError("INVALID_AMOUNT", `${name} must be a non-negative integer cents value`);
}

export function roundUpContributionCents(totalCents: number): number {
  assertCents(totalCents, "totalCents");
  return (ROUNDING_INCREMENT_CENTS - (totalCents % ROUNDING_INCREMENT_CENTS)) % ROUNDING_INCREMENT_CENTS;
}

export function formatEur(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new DomainError("INVALID_AMOUNT");
  return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(cents / 100);
}

