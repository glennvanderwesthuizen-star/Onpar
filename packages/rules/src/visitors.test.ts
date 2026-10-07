import {
  barredValue,
  categoryLimitText,
  DEFAULT_VISITOR_CATEGORIES,
  DEFAULT_VISITOR_SETTINGS,
  normaliseCell,
  normalisePlate,
  VISITOR_CHECK_INFO,
  VISITOR_CHECKS,
  visitorCategoryErrors,
  visitorSettingsErrors,
} from './visitors';

describe('visitor management: the groundwork', () => {
  it('starts every site on the positions in the spec', () => {
    expect(DEFAULT_VISITOR_SETTINGS.checks).toEqual({
      expiredLicenceOk: true,
      barredList: true,
      stolenVehicle: false,
      cellPin: false,
      paxCount: true,
      exitMatch: true,
      facePhoto: true,
      documents: false,
      entryLimit: true,
      overstayAlert: true,
      rollCall: true,
    });
    expect(DEFAULT_VISITOR_SETTINGS).toMatchObject({ noResponseSeconds: 120, secondContact: true, overstayEscalationMinutes: 30, retentionMonths: 12 });
    expect(visitorSettingsErrors(DEFAULT_VISITOR_SETTINGS)).toEqual({});
  });

  it('refuses to switch on a check that has nothing behind it yet', () => {
    const notYet = VISITOR_CHECKS.filter((c) => VISITOR_CHECK_INFO[c].notYet);
    expect(notYet).toEqual(['stolenVehicle', 'cellPin', 'documents']);
    for (const c of notYet) {
      const errors = visitorSettingsErrors({ ...DEFAULT_VISITOR_SETTINGS, checks: { ...DEFAULT_VISITOR_SETTINGS.checks, [c]: true } });
      expect(Object.keys(errors)).toEqual([`checks.${c}`]);
    }
  });

  it('keeps the waiting times within sensible limits', () => {
    expect(visitorSettingsErrors({ ...DEFAULT_VISITOR_SETTINGS, noResponseSeconds: 10 })).toEqual({ noResponseSeconds: 'Enter a whole number from 30 to 600 seconds.' });
    expect(visitorSettingsErrors({ ...DEFAULT_VISITOR_SETTINGS, overstayEscalationMinutes: 0, retentionMonths: 1.5 })).toEqual({
      overstayEscalationMinutes: 'Enter a whole number from 5 to 240 minutes.',
      retentionMonths: 'Enter a whole number from 1 to 120 months.',
    });
  });

  it('starts with the five categories and the limits the owner agreed (7 Oct 2026)', () => {
    expect(DEFAULT_VISITOR_CATEGORIES.map((c) => [c.name, c.kind, categoryLimitText(c)])).toEqual([
      ['Once-off visitor', 'once_off', '4 hours'],
      ['Regular visitor', 'regular', 'No limit'],
      ['Contractor, once-off', 'once_off', 'Until 17:00'],
      ['Regular contractor', 'regular', 'Until 17:00'],
      ['Contractor, fixed period', 'fixed_period', 'Until 17:00'],
    ]);
    for (const c of DEFAULT_VISITOR_CATEGORIES) expect(visitorCategoryErrors(c)).toEqual({});
  });

  it('allows one kind of time limit on a category, not both', () => {
    const base = { name: 'Delivery', kind: 'once_off' as const, contractor: false };
    expect(visitorCategoryErrors({ ...base, limitMinutes: 30, limitUntil: '17:00' })).toEqual({ limitUntil: 'Choose time on site or a time of day, not both.' });
    expect(visitorCategoryErrors({ ...base, limitMinutes: 5, limitUntil: null })).toEqual({ limitMinutes: 'Enter a time from 15 minutes to 7 days.' });
    expect(visitorCategoryErrors({ ...base, limitMinutes: null, limitUntil: '25:00' })).toEqual({ limitUntil: 'Enter a time of day, for example 17:00.' });
    expect(visitorCategoryErrors({ ...base, name: ' ', limitMinutes: null, limitUntil: null })).toEqual({ name: 'Enter a name for the category.' });
    expect(categoryLimitText({ limitMinutes: 90, limitUntil: null })).toBe('1 hour 30 minutes');
  });

  it('compares number plates, cell numbers and ID numbers however they were typed', () => {
    expect(normalisePlate('ca 123-456')).toBe('CA123456');
    expect(normalisePlate('BCD 123 GP')).toBe('BCD123GP');
    expect(normaliseCell('+27 82 555 0140')).toBe('0825550140');
    expect(normaliseCell('0027825550140')).toBe('0825550140');
    expect(normaliseCell('082 555-0140')).toBe('0825550140');
    expect(barredValue('registration', ' ca 123 456 ')).toEqual({ value: 'CA123456' });
    expect(barredValue('cell', '082 555')).toEqual({ error: 'Enter the full cell number.' });
    expect(barredValue('id_number', '800101 5009 087')).toEqual({ value: '8001015009087' });
    expect(barredValue('id_number', 'a1234567')).toEqual({ value: 'A1234567' });
    expect(barredValue('id_number', '12')).toEqual({ error: 'Enter the ID or passport number.' });
  });
});
