import {
  validateSaId,
  maskIdNumber,
  qualificationStatus,
  gradeMeetsMinimum,
  siteFitWarnings,
  enrolmentErrors,
  REQUIRED_PHOTO_KINDS,
  FIREARM_COMPETENCY,
  shiftErrors,
  siteErrors,
  shiftLengthMinutes,
  guardsNeededPerDay,
  can,
} from './index';

const TODAY = new Date('2026-09-27T10:00:00Z');

// Valid test numbers built with the Luhn check digit.
const VALID_ID = '8001015009087';
const VALID_ID_2 = '9202204720083';

describe('SA ID numbers', () => {
  it('accepts valid numbers and reads the date of birth', () => {
    expect(validateSaId(VALID_ID, TODAY)).toEqual({ valid: true, dateOfBirth: '1980-01-01', citizen: true });
    expect(validateSaId(VALID_ID_2, TODAY)).toMatchObject({ valid: true, dateOfBirth: '1992-02-20' });
  });
  it('ignores spaces', () => {
    expect(validateSaId('800101 5009 087', TODAY).valid).toBe(true);
  });
  it('rejects the wrong length or letters', () => {
    expect(validateSaId('800101500908', TODAY).valid).toBe(false);
    expect(validateSaId('80010150090A7', TODAY).valid).toBe(false);
  });
  it('rejects a wrong check digit', () => {
    const r = validateSaId('8001015009088', TODAY);
    expect(r).toMatchObject({ valid: false });
    expect((r as { reason: string }).reason).toMatch(/check digit/);
  });
  it('rejects an impossible date', () => {
    expect(validateSaId('8002305009087', TODAY)).toMatchObject({ valid: false });
  });
  it('rejects a bad citizenship digit', () => {
    expect(validateSaId('8001015009387', TODAY)).toMatchObject({ valid: false });
  });
  it('treats 2-digit years in the future as the 1900s', () => {
    // 30 → 1930, since 2030 is after "today"
    expect(validateSaId('3001015009082', TODAY)).toMatchObject({ valid: true, dateOfBirth: '1930-01-01' });
  });
  it('masks all but the last four digits', () => {
    expect(maskIdNumber(VALID_ID)).toBe('•••••••••9087');
  });
});

describe('qualification status', () => {
  it('is compliant, expiring or expired', () => {
    expect(qualificationStatus('2027-06-01', '2026-09-27')).toBe('COMPLIANT');
    expect(qualificationStatus('2026-10-20', '2026-09-27')).toBe('EXPIRING');
    expect(qualificationStatus('2026-09-27', '2026-09-27')).toBe('EXPIRING');
    expect(qualificationStatus('2026-09-26', '2026-09-27')).toBe('EXPIRED');
    expect(qualificationStatus(null, '2026-09-27')).toBe('COMPLIANT');
  });
});

describe('grades and site fit (scenario 11, section 39)', () => {
  const unarmed = { name: 'Estate ABC', minimumGrade: 'C' as const, armed: false };
  const armed = { name: 'Office Park', minimumGrade: 'C' as const, armed: true };

  it('orders grades A highest to E lowest', () => {
    expect(gradeMeetsMinimum('A', 'C')).toBe(true);
    expect(gradeMeetsMinimum('C', 'C')).toBe(true);
    expect(gradeMeetsMinimum('D', 'C')).toBe(false);
  });
  it('warns when the grade is below the site minimum', () => {
    expect(siteFitWarnings({ psiraGrade: 'E', qualifications: [] }, unarmed, TODAY)).toEqual([
      "PSIRA grade E is below Estate ABC's minimum of grade C.",
    ]);
    expect(siteFitWarnings({ psiraGrade: 'B', qualifications: [] }, unarmed, TODAY)).toEqual([]);
  });
  it('warns at an armed site without firearm competency', () => {
    expect(siteFitWarnings({ psiraGrade: 'B', qualifications: [] }, armed, TODAY)[0]).toMatch(/no firearm competency/);
  });
  it('warns at an armed site when the competency has expired', () => {
    const q = [{ type: FIREARM_COMPETENCY, expiryDate: '2026-01-01' }];
    expect(siteFitWarnings({ psiraGrade: 'B', qualifications: q }, armed, TODAY)[0]).toMatch(/expired/);
  });
  it('is happy at an armed site with valid competency', () => {
    const q = [{ type: FIREARM_COMPETENCY, expiryDate: '2027-01-01' }];
    expect(siteFitWarnings({ psiraGrade: 'B', qualifications: q }, armed, TODAY)).toEqual([]);
  });
});

describe('enrolment (scenario 11)', () => {
  const complete = {
    fullName: 'John Smith',
    idNumber: VALID_ID,
    cellNumber: '082 555 0101',
    nextOfKinName: 'Mary Smith',
    nextOfKinNumber: '+27825550102',
    psiraNumber: '1234567',
    psiraGrade: 'C',
    psiraExpiry: '2027-03-31',
    siteId: 'site-1',
    photoKinds: [...REQUIRED_PHOTO_KINDS],
  };

  it('allows a complete enrolment', () => {
    expect(enrolmentErrors(complete, TODAY)).toEqual({});
  });
  it('blocks when any of the four photos is missing', () => {
    const e = enrolmentErrors({ ...complete, photoKinds: ['face', 'full_body', 'id_document'] }, TODAY);
    expect(e.photos).toBe('All four photos are required. Missing: PSIRA card.');
  });
  it('blocks when required fields are missing', () => {
    const e = enrolmentErrors({ photoKinds: [] }, TODAY);
    expect(Object.keys(e).sort()).toEqual(
      [
        'cellNumber',
        'fullName',
        'idNumber',
        'nextOfKinName',
        'nextOfKinNumber',
        'photos',
        'psiraExpiry',
        'psiraGrade',
        'psiraNumber',
        'siteId',
      ].sort(),
    );
  });
  it('blocks an invalid ID number, phone number or grade', () => {
    const e = enrolmentErrors({ ...complete, idNumber: '8001015009088', cellNumber: '12345', psiraGrade: 'F' }, TODAY);
    expect(e.idNumber).toMatch(/check digit/);
    expect(e.cellNumber).toMatch(/South African/);
    expect(e.psiraGrade).toMatch(/A, B, C, D or E/);
  });
});

describe('shifts and sites (sections 6.13, 36, 41)', () => {
  const day = { name: 'Day', kind: 'day', startTime: '06:00', endTime: '18:00', guardsRequired: 2 };
  const night = { name: 'Night', kind: 'night', startTime: '18:00', endTime: '06:00', guardsRequired: 1 };
  const site = {
    name: 'Estate ABC',
    address: 'Sandton',
    client: 'Estate ABC HOA',
    province: 'GP',
    minimumGrade: 'C',
    armed: false,
    payrollStartDay: 26,
    shifts: [day, night],
  };

  it('accepts a valid site', () => {
    expect(siteErrors(site)).toEqual({});
  });
  it('never allows fewer than 1 guard on a shift', () => {
    expect(shiftErrors({ ...day, guardsRequired: 0 }).guardsRequired).toBeDefined();
  });
  it('rejects bad times and same start and end', () => {
    expect(shiftErrors({ ...day, startTime: '25:00' }).startTime).toBeDefined();
    expect(shiftErrors({ ...day, endTime: '06:00' }).endTime).toBeDefined();
  });
  it('needs a province, which starts the guards\' TSF numbers', () => {
    expect(siteErrors({ ...site, province: null }).province).toMatch(/province/);
    expect(siteErrors({ ...site, province: 'XX' }).province).toMatch(/province/);
  });
  it('keys shift errors by position', () => {
    expect(siteErrors({ ...site, shifts: [day, { ...night, name: '' }] })).toEqual({
      'shifts.1.name': 'Give the shift a name, for example Day.',
    });
  });
  it('limits the payroll start day to 1–28', () => {
    expect(siteErrors({ ...site, payrollStartDay: 31 }).payrollStartDay).toBeDefined();
    expect(siteErrors({ ...site, payrollStartDay: 1 }).payrollStartDay).toBeUndefined();
  });
  it('measures overnight shifts', () => {
    expect(shiftLengthMinutes('06:00', '18:00')).toBe(720);
    expect(shiftLengthMinutes('18:00', '06:00')).toBe(720);
    expect(shiftLengthMinutes('22:00', '07:00')).toBe(540);
  });
  it('adds up guards needed per day', () => {
    expect(guardsNeededPerDay([day, night])).toBe(3);
  });
});

describe('permissions', () => {
  it('lets only managers and admins enrol officers', () => {
    expect(can('company_manager', 'officers.enrol')).toBe(true);
    expect(can('site_supervisor', 'officers.enrol')).toBe(false);
    expect(can('site_supervisor', 'officers.unlock')).toBe(true);
  });
});
