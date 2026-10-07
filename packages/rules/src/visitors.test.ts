import {
  barredValue,
  categoryLimitText,
  DEFAULT_VISITOR_CATEGORIES,
  DEFAULT_VISITOR_SETTINGS,
  exceptionHandlingError,
  exitExceptions,
  normaliseCell,
  normalisePlate,
  overstayActionError,
  overstayDealtWith,
  stayText,
  visitDueAt,
  passErrors,
  passWhen,
  VISITOR_CHECK_INFO,
  VISITOR_CHECKS,
  visitorCategoryErrors,
  visitorSettingsErrors,
  visitWarnings,
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

  it('warns about an expired licence or disc only when the site does not accept them', () => {
    expect(visitWarnings({ expiredLicenceOk: true }, '2026-10-07', '2020-01-01', '2020-01-01')).toEqual([]);
    expect(visitWarnings({ expiredLicenceOk: false }, '2026-10-07', '2026-10-06', '2026-10-07')).toEqual(['licence_expired']);
    expect(visitWarnings({ expiredLicenceOk: false }, '2026-10-07', null, '2026-09-30')).toEqual(['disc_expired']);
  });

  describe('a pass a customer makes for a visitor', () => {
    const once = { kind: 'once' as const, visitorName: 'Sipho Nkosi', categoryKind: 'once_off' as const, idNumber: '', cell: '082 555 0140', registration: '', visitDate: '2026-10-08', time: null, days: [], hoursFrom: null, hoursTo: null, startDate: null, endDate: null };
    const regular = { ...once, kind: 'ongoing' as const, categoryKind: 'regular' as const, visitDate: null, days: [1, 3, 5], hoursFrom: '08:00', hoursTo: '17:00' };

    it('needs a name and at least one way for the gate to recognise the visitor', () => {
      expect(passErrors(once, '2026-10-07')).toEqual({});
      expect(passErrors({ ...once, cell: '', visitorName: 'S' }, '2026-10-07')).toEqual({ visitorName: 'Enter the visitor’s name.', identifier: 'Give at least one: their ID number, cell number or number plate.' });
      expect(passErrors({ ...once, cell: '082', registration: 'ca 123 456' }, '2026-10-07')).toEqual({ cell: 'Enter the full cell number.' });
    });

    it('takes one visit on a day that has not passed, with an optional time', () => {
      expect(passErrors({ ...once, visitDate: '2026-10-06' }, '2026-10-07')).toEqual({ visitDate: 'That day has passed.' });
      expect(passErrors({ ...once, visitDate: null }, '2026-10-07')).toEqual({ visitDate: 'Choose the day they are coming.' });
      expect(passErrors({ ...once, time: '25:00' }, '2026-10-07')).toEqual({ time: 'Enter the time, for example 14:30.' });
      expect(passErrors({ ...once, categoryKind: 'regular' }, '2026-10-07')).toEqual({ categoryId: 'Choose a kind of visitor that is for one visit.' });
      expect(passWhen({ ...once, time: '14:30' })).toBe('2026-10-08, about 14:30');
    });

    it('takes a regular on set days and hours, and a fixed-period contractor between two dates', () => {
      expect(passErrors(regular, '2026-10-07')).toEqual({});
      expect(passErrors({ ...regular, categoryKind: 'once_off' }, '2026-10-07')).toEqual({ categoryId: 'Choose a kind of visitor that comes regularly.' });
      expect(passErrors({ ...regular, hoursTo: null }, '2026-10-07')).toEqual({ hoursTo: 'Give both the start and the end time, or neither.' });
      expect(passErrors({ ...regular, hoursTo: '07:00' }, '2026-10-07')).toEqual({ hoursTo: 'The end time must be after the start time.' });
      expect(passErrors({ ...regular, days: [0, 8] }, '2026-10-07')).toEqual({ days: 'Choose the days of the week.' });
      expect(passErrors({ ...regular, categoryKind: 'fixed_period' }, '2026-10-07')).toEqual({ startDate: 'Choose the first day.', endDate: 'Choose the last day.' });
      expect(passErrors({ ...regular, categoryKind: 'fixed_period', startDate: '2026-10-10', endDate: '2026-10-09' }, '2026-10-07')).toEqual({ endDate: 'The last day must be on or after the first day.' });
      expect(passWhen(regular)).toBe('Mon, Wed, Fri, 08:00 to 17:00');
      expect(passWhen({ ...regular, days: [], hoursFrom: null, hoursTo: null, startDate: '2026-10-10', endDate: '2026-11-20' })).toBe('Every day, any time, 2026-10-10 to 2026-11-20');
    });
  });

  describe('a visitor leaving', () => {
    const on = { exitMatch: true, paxCount: true };
    const car = { type: 'vehicle' as const, paxIn: 2 };
    const walker = { type: 'pedestrian' as const, paxIn: null };

    it('closes the visit cleanly when the person, vehicle and passengers match', () => {
      expect(exitExceptions(on, { visit: car, samePerson: true, sameVehicle: true, paxOut: 2 })).toEqual([]);
      expect(exitExceptions(on, { visit: walker, samePerson: true, sameVehicle: true, paxOut: null })).toEqual([]);
    });

    it('raises each of the spec\u2019s four exceptions', () => {
      expect(exitExceptions(on, { visit: car, samePerson: false, sameVehicle: true, paxOut: 2 })).toEqual(['driver_mismatch']);
      expect(exitExceptions(on, { visit: car, samePerson: true, sameVehicle: false, paxOut: null })).toEqual(['vehicle_mismatch']);
      expect(exitExceptions(on, { visit: walker, samePerson: true, sameVehicle: false, paxOut: 0 })).toEqual(['vehicle_mismatch']);
      expect(exitExceptions(on, { visit: car, samePerson: true, sameVehicle: true, paxOut: 1 })).toEqual(['pax_mismatch']);
      expect(exitExceptions(on, { visit: null, samePerson: null, sameVehicle: false, paxOut: null })).toEqual(['no_open_visit']);
      expect(exitExceptions(on, { visit: car, samePerson: false, sameVehicle: true, paxOut: 5 })).toEqual(['driver_mismatch', 'pax_mismatch']);
    });

    it('leaves out a difference whose check the site has switched off', () => {
      expect(exitExceptions({ exitMatch: false, paxCount: true }, { visit: car, samePerson: false, sameVehicle: false, paxOut: 2 })).toEqual([]);
      expect(exitExceptions({ exitMatch: true, paxCount: false }, { visit: car, samePerson: true, sameVehicle: true, paxOut: 0 })).toEqual([]);
      expect(exitExceptions({ exitMatch: false, paxCount: false }, { visit: null, samePerson: null, sameVehicle: false, paxOut: null })).toEqual(['no_open_visit']);
    });

    it('makes the guard pick a reason or type a note', () => {
      expect(exceptionHandlingError(null, '')).toBe('Choose a reason or type a note before you continue.');
      expect(exceptionHandlingError('other', ' ')).toBe('Type a note to say what happened.');
      expect(exceptionHandlingError('made_up', 'x')).toBe('Choose a reason from the list.');
      expect(exceptionHandlingError('passenger_driving', '')).toBeNull();
      expect(exceptionHandlingError(null, 'His wife is driving.')).toBeNull();
    });
  });

  describe('how long a visitor may stay', () => {
    const at = (t: string) => new Date(`${t}+02:00`);
    const none = { limitMinutes: null, limitUntil: null, pass: null };

    it('uses the category: so many minutes, or gone by a time of day', () => {
      expect(visitDueAt({ ...none, entryAt: at('2026-10-07T10:00:00'), limitMinutes: 240 })).toEqual(at('2026-10-07T14:00:00'));
      expect(visitDueAt({ ...none, entryAt: at('2026-10-07T10:00:00'), limitUntil: '17:00' })).toEqual(at('2026-10-07T17:00:00'));
      expect(visitDueAt({ ...none, entryAt: at('2026-10-07T10:00:00') })).toBeNull();
    });

    it('gives a visitor let in after the time of day until that time the next day', () => {
      expect(visitDueAt({ ...none, entryAt: at('2026-10-07T18:30:00'), limitUntil: '17:00:00' })).toEqual(at('2026-10-08T17:00:00'));
      expect(visitDueAt({ ...none, entryAt: at('2026-10-31T23:30:00'), limitUntil: '17:00' })).toEqual(at('2026-11-01T17:00:00'));
    });

    it('also ends with the day announced, a regular\u2019s hours, or the last day of a fixed period: whichever comes first', () => {
      const once = { kind: 'once' as const, visitDate: '2026-10-07', hoursTo: null, endDate: null };
      expect(visitDueAt({ ...none, entryAt: at('2026-10-07T22:00:00'), limitMinutes: 240, pass: once })).toEqual(at('2026-10-08T00:00:00'));
      expect(visitDueAt({ ...none, entryAt: at('2026-10-07T09:00:00'), limitMinutes: 240, pass: once })).toEqual(at('2026-10-07T13:00:00'));
      const regular = { kind: 'ongoing' as const, visitDate: null, hoursTo: '16:00', endDate: '2026-10-09' };
      expect(visitDueAt({ ...none, entryAt: at('2026-10-07T08:00:00'), limitUntil: '17:00', pass: regular })).toEqual(at('2026-10-07T16:00:00'));
      expect(visitDueAt({ ...none, entryAt: at('2026-10-09T08:00:00'), pass: { ...regular, hoursTo: null } })).toEqual(at('2026-10-10T00:00:00'));
    });

    it('writes time on site in a short form', () => {
      expect(stayText(44 * 60_000)).toBe('44 min');
      expect(stayText(185 * 60_000)).toBe('3 h 05 min');
      expect(stayText((2 * 24 + 4) * 3600_000)).toBe('2 days 4 h');
    });

    it('counts an overstay as dealt with only when confirmed since the last handover began', () => {
      const t = (h: number) => new Date(Date.UTC(2026, 9, 7, h));
      expect(overstayDealtWith(null, null)).toBe(false);
      expect(overstayDealtWith({ action: 'dialled', at: t(10) }, null)).toBe(false);
      expect(overstayDealtWith({ action: 'confirmed', at: t(10) }, null)).toBe(true);
      expect(overstayDealtWith({ action: 'confirmed', at: t(10) }, t(16))).toBe(false);
      expect(overstayDealtWith({ action: 'confirmed', at: t(16) }, t(16))).toBe(true);
      expect(overstayActionError('confirmed', ' ')).toBe('Type a note to say what you found.');
      expect(overstayActionError('dialled', '')).toBeNull();
      expect(overstayActionError('left', 'Tenant says he left at lunch.')).toBeNull();
    });
  });
});
