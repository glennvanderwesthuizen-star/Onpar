import {
  offlineOutcome,
  passAppliesAt,
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
  staffCode,
  staffEntryAutomatic,
  staffEntryNeedsReason,
  staffErrors,
  stayText,
  stayUntil,
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
      staffFaceMatch: true,
    });
    expect(DEFAULT_VISITOR_SETTINGS).toMatchObject({ noResponseSeconds: 120, secondContact: true, overstayEscalationMinutes: 30 });
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
    expect(visitorSettingsErrors({ ...DEFAULT_VISITOR_SETTINGS, overstayEscalationMinutes: 0 })).toEqual({
      overstayEscalationMinutes: 'Enter a whole number from 5 to 240 minutes.',
    });
  });

  it('starts with two kinds of visitor: a visitor with no time limit, and a contractor gone by 18:00 (owner, 7 Oct 2026)', () => {
    expect(DEFAULT_VISITOR_CATEGORIES.map((c) => [c.name, c.contractor, categoryLimitText(c)])).toEqual([
      ['Visitor', false, 'No limit'],
      ['Contractor', true, 'Until 18:00'],
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
    const once = { kind: 'once' as const, visitorName: 'Sipho Nkosi', idNumber: '', cell: '082 555 0140', registration: '', visitDate: '2026-10-08', time: null, days: [], hoursFrom: null, hoursTo: null, startDate: null, endDate: null, contractor: false, maxWorkers: null, leaveBy: null };
    const regular = { ...once, kind: 'ongoing' as const, visitDate: null, days: [1, 3, 5], hoursFrom: '08:00', hoursTo: '17:00' };

    it('needs a name and at least one way for the gate to recognise the visitor', () => {
      expect(passErrors(once, '2026-10-07')).toEqual({});
      expect(passErrors({ ...once, cell: '', visitorName: 'S' }, '2026-10-07')).toEqual({ visitorName: 'Enter the visitor’s name.', identifier: 'Give at least one: their ID number, cell number or number plate.' });
      expect(passErrors({ ...once, cell: '082', registration: 'ca 123 456' }, '2026-10-07')).toEqual({ cell: 'Enter the full cell number.' });
    });

    it('needs a contractor\u2019s cell number and how many workers may come with them', () => {
      const c = { ...once, contractor: true, cell: '', registration: 'CA 1' };
      expect(passErrors(c, '2026-10-07')).toEqual({ cell: 'Enter the contractor\u2019s cell number.', maxWorkers: 'Enter how many workers may come with them (0 if none).' });
      expect(passErrors({ ...c, cell: '082 555 0140', maxWorkers: 4, leaveBy: '6pm' }, '2026-10-07')).toEqual({ leaveBy: 'Enter the time, for example 18:00.' });
      expect(passErrors({ ...c, cell: '082 555 0140', maxWorkers: 0, leaveBy: '18:00' }, '2026-10-07')).toEqual({});
    });

    it('takes one visit on a day that has not passed, with an optional time', () => {
      expect(passErrors({ ...once, visitDate: '2026-10-06' }, '2026-10-07')).toEqual({ visitDate: 'That day has passed.' });
      expect(passErrors({ ...once, visitDate: null }, '2026-10-07')).toEqual({ visitDate: 'Choose the day they are coming.' });
      expect(passErrors({ ...once, time: '25:00' }, '2026-10-07')).toEqual({ time: 'Enter the time, for example 14:30.' });
      expect(passWhen({ ...once, time: '14:30' })).toBe('2026-10-08, about 14:30');
    });

    it('takes a regular on set days and hours, and a fixed-period contractor between two dates', () => {
      expect(passErrors(regular, '2026-10-07')).toEqual({});
      expect(passErrors({ ...regular, hoursTo: null }, '2026-10-07')).toEqual({ hoursTo: 'Give both the start and the end time, or neither.' });
      expect(passErrors({ ...regular, hoursTo: '07:00' }, '2026-10-07')).toEqual({ hoursTo: 'The end time must be after the start time.' });
      expect(passErrors({ ...regular, days: [0, 8] }, '2026-10-07')).toEqual({ days: 'Choose the days of the week.' });
      expect(passErrors({ ...regular, startDate: '2026-10-10', endDate: '2026-10-09' }, '2026-10-07')).toEqual({ endDate: 'The last day must be on or after the first day.' });
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

    it('lets a contractor\u2019s own time, and the customer\u2019s "still busy until", take the place of the site\u2019s limit', () => {
      const pass = { kind: 'ongoing' as const, visitDate: null, hoursTo: null, endDate: null, leaveBy: '16:30' };
      expect(visitDueAt({ ...none, entryAt: at('2026-10-07T08:00:00'), limitUntil: '18:00', pass })).toEqual(at('2026-10-07T16:30:00'));
      expect(visitDueAt({ ...none, entryAt: at('2026-10-07T08:00:00'), limitUntil: '18:00', pass, extendedTo: at('2026-10-07T21:00:00') })).toEqual(at('2026-10-07T21:00:00'));
      expect(stayUntil(at('2026-10-07T18:05:00'), '21:00')).toEqual(at('2026-10-07T21:00:00'));
      expect(stayUntil(at('2026-10-07T23:30:00'), '01:00')).toEqual(at('2026-10-08T01:00:00'));
      expect(stayUntil(at('2026-10-07T18:05:00'), '9pm')).toBeNull();
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

  describe('staff of a unit', () => {
    const grace = { fullName: 'Grace Mokoena', cell: '+27 82 555 0147', idNumber: '', days: [1, 2, 3, 4, 5], hoursFrom: '07:00', hoursTo: '16:00', endDate: null, byVehicle: false, registration: '' };

    it('gives each a code: the last six digits of their cell number, however it was typed', () => {
      expect(staffCode('+27 82 555 0147')).toBe('550147');
      expect(staffCode('082-555-0147')).toBe('550147');
      expect(staffCode('0147')).toBeNull();
    });

    it('needs a name and a full cell number, and sensible days and hours', () => {
      expect(staffErrors(grace, '2026-10-07')).toEqual({});
      expect(staffErrors({ ...grace, fullName: ' ', cell: '555 0147' }, '2026-10-07')).toEqual({ fullName: 'Enter their name.', cell: 'Enter their full cell number. They give its last six digits at the gate.' });
      expect(staffErrors({ ...grace, hoursTo: '06:00', endDate: '2026-10-01', idNumber: '12' }, '2026-10-07')).toEqual({ idNumber: 'Enter the full ID or passport number.', hoursTo: 'The end time must be after the start time.', endDate: 'That day has passed.' });
    });

    it('asks the guard for a reason only when he, or the comparison, is in doubt', () => {
      expect(staffEntryNeedsReason(true, 'match')).toBe(false);
      expect(staffEntryNeedsReason(true, 'off')).toBe(false);
      expect(staffEntryNeedsReason(true, 'no_face')).toBe(false);
      expect(staffEntryNeedsReason(true, 'uncertain')).toBe(true);
      expect(staffEntryNeedsReason(true, 'no_match')).toBe(true);
      expect(staffEntryNeedsReason(false, 'match')).toBe(true);
      // Only a clear match lets someone in without the guard deciding.
      expect(['match', 'uncertain', 'no_match', 'no_face', 'off'].map((r) => staffEntryAutomatic(r as 'match'))).toEqual([true, false, false, false, false]);
      expect(staffErrors({ ...grace, byVehicle: true }, '2026-10-07')).toEqual({ registration: 'Enter the number plate of their vehicle.' });
      expect(staffErrors({ ...grace, byVehicle: true, registration: 'ca 123-456' }, '2026-10-07')).toEqual({});
    });
  });
});

describe('the gate without signal', () => {
  const once = { kind: 'once' as const, visitDate: '2026-10-08', time: null, days: null, hoursFrom: null, hoursTo: null, startDate: null, endDate: null };
  it('a one-visit pass with no time applies all that day only', () => {
    expect(passAppliesAt(once, '2026-10-08', '23:59', 4)).toBe(true);
    expect(passAppliesAt(once, '2026-10-09', '00:01', 5)).toBe(false);
  });
  it('a one-visit pass with a time applies one hour either side, also across midnight', () => {
    const p = { ...once, time: '10:00' };
    expect(passAppliesAt(p, '2026-10-08', '09:00', 4)).toBe(true);
    expect(passAppliesAt(p, '2026-10-08', '11:00', 4)).toBe(true);
    expect(passAppliesAt(p, '2026-10-08', '11:01', 4)).toBe(false);
    const late = { ...once, time: '23:30' };
    expect(passAppliesAt(late, '2026-10-09', '00:20', 5)).toBe(true);
    expect(passAppliesAt(late, '2026-10-09', '00:31', 5)).toBe(false);
  });
  it('a regular applies on his days, between his hours and within his dates', () => {
    const r = { ...once, kind: 'ongoing' as const, visitDate: null, days: [1, 2, 3, 4, 5], hoursFrom: '07:00', hoursTo: '17:00', startDate: '2026-10-01', endDate: '2026-10-31' };
    expect(passAppliesAt(r, '2026-10-08', '07:00', 4)).toBe(true);
    expect(passAppliesAt(r, '2026-10-08', '17:01', 4)).toBe(false);
    expect(passAppliesAt(r, '2026-10-10', '09:00', 6)).toBe(false);
    expect(passAppliesAt(r, '2026-11-02', '09:00', 1)).toBe(false);
    expect(passAppliesAt(r, '2026-09-30', '09:00', 3)).toBe(false);
  });
  it('records the visit as the guard decided it at the gate', () => {
    expect(offlineOutcome('pass')).toEqual({ status: 'on_site', deniedReason: null, call: null });
    expect(offlineOutcome('approved').status).toBe('on_site');
    expect(offlineOutcome('denied')).toEqual({ status: 'denied', deniedReason: 'phone', call: 'denied' });
    expect(offlineOutcome('no_answer')).toEqual({ status: 'denied_no_response', deniedReason: 'no_response', call: 'no_response' });
    expect(offlineOutcome('barred').deniedReason).toBe('barred');
  });
});
