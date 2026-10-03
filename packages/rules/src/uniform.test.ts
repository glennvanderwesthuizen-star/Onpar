import { formatRand, guardPaysStatement, isDue, nextDueDate, orderTotals } from './index';

describe('uniform (D-33)', () => {
  it('is due again 12 months after it was last issued, keeping the day of the month', () => {
    expect(nextDueDate('2026-03-15')).toBe('2027-03-15');
    expect(nextDueDate('2028-02-29')).toBe('2029-02-28');
    expect(nextDueDate('2026-01-31', 1)).toBe('2026-02-28');
    expect(nextDueDate(null)).toBeNull();
  });

  it('never-issued items are due; issued ones only from their renewal date', () => {
    expect(isDue(null, '2026-10-03')).toBe(true);
    expect(isDue('2025-10-03', '2026-10-03')).toBe(true);
    expect(isDue('2025-10-04', '2026-10-03')).toBe(false);
  });

  it('totals the company account and the guard account; declined lines count for neither', () => {
    expect(
      orderTotals([
        { quantity: 3, decision: 'company', unitPriceCents: 25000 },
        { quantity: 1, decision: 'guard', unitPriceCents: 45050 },
        { quantity: 2, decision: 'declined', unitPriceCents: 10000 },
        { quantity: 1, decision: null, unitPriceCents: 10000 },
      ]),
    ).toEqual({ companyCents: 75000, guardCents: 45050 });
  });

  it('writes Rand amounts the South African way', () => {
    expect(formatRand(123450)).toBe('R1 234.50');
    expect(formatRand(5)).toBe('R0.05');
    expect(formatRand(100000000)).toBe('R1 000 000.00');
    expect(guardPaysStatement(45050)).toContain('R450.50');
  });
});
