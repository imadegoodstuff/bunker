/**
 * Rows the `/commitments` endpoint may hand to a wallet: the longest run that
 * starts exactly at `from` with no missing leaf index. A hole means the scanner
 * has deferred the transaction that produced those leaves (`skipped_signatures`);
 * serving anything past it would let a wallet build a tree with the wrong
 * leaves in the wrong positions.
 */
export function contiguousPrefix<T extends { idx: number }>(rows: T[], from: number): T[] {
  let n = 0;
  while (n < rows.length && rows[n].idx === from + n) n++;
  return rows.slice(0, n);
}
