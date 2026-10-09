import { needsHandDelivery, noticeErrors, noticeStatus, noticeTemplate, suggestedActions } from './notices';

const ctx = { companyName: 'TSF Demo Security', employeeName: 'John Smith', employeeNumber: 'E001', siteName: 'Estate ABC', date: '2026-10-08', issuedBy: 'Hazel HR', prior: 1, details: { charge: 'Late for duty', incidentDate: '2026-10-07' } };

describe('HR notices', () => {
  it('fills the template from the employee record and counts the warnings already on file', () => {
    const t = noticeTemplate('written_warning', ctx);
    expect(t.subject).toBe('Written warning: Late for duty');
    expect(t.body).toContain('To: John Smith (employee number E001), Estate ABC');
    expect(t.body).toContain('on 2026-10-07: Late for duty.');
    expect(t.body).toContain('There is already 1 written warning on your file. This is your second.');
  });

  it('lists the employee’s rights and the witnesses in a notice to appear', () => {
    const t = noticeTemplate('notice_to_appear', { ...ctx, prior: 0, details: { charge: 'Sleeping on duty', hearingDate: '2026-10-20', hearingTime: '10:00', venue: 'Head office', witnesses: ['Peter Supervisor', ''] } });
    expect(t.body).toContain('Venue: Head office');
    expect(t.body).toContain('To be represented by a fellow employee or a shop steward.');
    expect(t.body).toContain('- Peter Supervisor');
    expect(noticeErrors('notice_to_appear', t.subject, t.body, {})).toMatchObject({ hearingDate: expect.any(String), venue: expect.any(String) });
  });

  it('will not send a notice with parts still to fill in', () => {
    const t = noticeTemplate('written_warning', ctx);
    expect(noticeErrors('written_warning', t.subject, t.body, ctx.details)).toEqual({ body: 'Fill in or remove every part in [square brackets] before sending.' });
    expect(noticeErrors('written_warning', t.subject, t.body.replace('[validity period]', 'six months'), ctx.details)).toBeNull();
  });

  it('tracks where a notice stands, and when hand delivery is needed', () => {
    expect(noticeStatus([{ kind: 'sent' }, { kind: 'delivered' }, { kind: 'opened' }])).toBe('opened');
    expect(noticeStatus([{ kind: 'sent' }, { kind: 'hand_delivery_requested' }, { kind: 'acknowledged' }])).toBe('acknowledged');
    const sent = new Date('2026-10-08T08:00:00Z');
    expect(needsHandDelivery(sent, [{ kind: 'sent' }], 48, new Date('2026-10-10T07:59:00Z'))).toBe(false);
    expect(needsHandDelivery(sent, [{ kind: 'sent' }, { kind: 'opened' }], 48, new Date('2026-10-10T08:00:00Z'))).toBe(true);
    expect(needsHandDelivery(sent, [{ kind: 'sent' }, { kind: 'acknowledged' }], 48, new Date('2026-10-12T08:00:00Z'))).toBe(false);
  });

  it('suggests looking at a pattern, never when a warning is already on file', () => {
    expect(suggestedActions({ lateArrivals30: 3, missedTasks30: 0, recentWarning: false })).toEqual([
      { pattern: '3 late arrivals in the last 30 days and no warning on file', suggest: 'verbal_warning', charge: 'Late for duty 3 times in the last 30 days' },
    ]);
    expect(suggestedActions({ lateArrivals30: 9, missedTasks30: 9, recentWarning: true })).toEqual([]);
    expect(suggestedActions({ lateArrivals30: 2, missedTasks30: 4, recentWarning: false })).toEqual([]);
  });
});
