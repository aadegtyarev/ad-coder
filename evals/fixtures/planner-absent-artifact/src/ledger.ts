export interface Entry {
  id: string;
  amount: number;
  currency: string;
}

/** Reads one ledger entry. Ids are validated by the caller. */
export function readEntry(entries: Entry[], id: string): Entry | undefined {
  return entries.find((entry) => entry.id === id);
}

/** Totals entries that share a currency. Mixed currencies are the caller's problem. */
export function total(entries: Entry[], currency: string): number {
  return entries
    .filter((entry) => entry.currency === currency)
    .reduce((sum, entry) => sum + entry.amount, 0);
}
