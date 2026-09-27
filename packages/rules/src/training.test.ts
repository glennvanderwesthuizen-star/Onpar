import { complianceSummary, currentQualifications, qualificationStatus } from './index';

describe('current qualifications (renewals)', () => {
  it('uses the record with the latest expiry per type', () => {
    const r = currentQualifications([
      { type: 'first_aid', name: 'First aid level 1', expiryDate: '2025-01-10' },
      { type: 'first_aid', name: 'First aid level 1', expiryDate: '2028-01-10' },
      { type: 'firearm_competency', name: 'Handgun', expiryDate: '2026-10-01' },
    ]);
    expect(r.map((x) => `${x.type}:${x.expiryDate}`).sort()).toEqual(['firearm_competency:2026-10-01', 'first_aid:2028-01-10']);
  });
  it('treats no expiry as the latest, and keeps different "other" qualifications apart', () => {
    const r = currentQualifications([
      { type: 'other', name: 'Dog handling', expiryDate: '2027-01-01' },
      { type: 'other', name: 'Control room', expiryDate: null },
      { type: 'other', name: 'dog handling ', expiryDate: null },
    ]);
    expect(r).toHaveLength(2);
    expect(r.every((x) => x.expiryDate === null)).toBe(true);
  });
});

describe('compliance summary (section 6.11)', () => {
  it('counts compliant, expiring and expired, with a percentage', () => {
    const today = '2026-09-27';
    const s = complianceSummary(['2027-06-01', '2026-10-10', '2026-09-01', null].map((d) => qualificationStatus(d, today)));
    expect(s).toEqual({ total: 4, compliant: 2, expiring: 1, expired: 1, compliantPercent: 50 });
  });
  it('is 100% when nothing is tracked', () => {
    expect(complianceSummary([]).compliantPercent).toBe(100);
  });
});
