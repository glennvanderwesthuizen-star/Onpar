import {
  PLATE_LETTERS,
  formatTsfNumber,
  generateTsfNumber,
  idCardQr,
  normaliseTsfNumber,
  parseIdCardQr,
  provinceName,
  badgeUrl,
  isBadgeToken,
  parseCardQr,
  tsfNumberProvince,
} from './tsf-number';

describe('TSF number (plate-style guard username)', () => {
  it('leaves out vowels and Q, like Gauteng plates', () => {
    expect(PLATE_LETTERS).toHaveLength(20);
    for (const c of 'AEIOUQ') expect(PLATE_LETTERS).not.toContain(c);
  });

  it('is generated from the province of the home site', () => {
    let i = 0;
    const seq = [0, 1, 2, 122];
    const n = generateTsfNumber('GP', () => seq[i++]);
    expect(n).toBe('BCD123GP');
    expect(formatTsfNumber(n)).toBe('BCD 123 GP');
    expect(tsfNumberProvince(n)).toBe('GP');
    expect(generateTsfNumber('KZN', () => 0)).toBe('BBB001KZN');
  });

  it('always generates valid numbers', () => {
    for (let k = 0; k < 500; k++) {
      const n = generateTsfNumber('WC', (max) => Math.floor(Math.random() * max));
      expect(normaliseTsfNumber(n)).toBe(n);
    }
  });

  it('accepts typing with spaces, dashes and small letters', () => {
    expect(normaliseTsfNumber(' bcd 123-gp ')).toBe('BCD123GP');
    expect(normaliseTsfNumber('BCD 123 KZN')).toBe('BCD123KZN');
  });

  it('refuses numbers that do not follow the pattern', () => {
    for (const bad of ['ABC 123 GP', 'BCD 000 GP', 'BCD 12 GP', 'BCD 123 XX', 'BQD 123 GP', '0042', '']) {
      expect(normaliseTsfNumber(bad)).toBeNull();
    }
  });

  it('reads an ID card QR, and refuses a checkpoint or other QR', () => {
    expect(parseIdCardQr(idCardQr('BCD123GP'))).toBe('BCD123GP');
    expect(parseIdCardQr('onpar-id:bcd123gp')).toBe('BCD123GP');
    expect(parseIdCardQr('BCD123GP')).toBeNull();
    expect(parseIdCardQr('https://example.com/p/abc')).toBeNull();
    expect(parseIdCardQr('ONPAR-ID:nonsense')).toBeNull();
  });

  it('names the provinces', () => {
    expect(provinceName('NC')).toBe('Northern Cape');
    expect(provinceName(null)).toBe('');
  });
});

describe('ID badge v2 (opaque card code)', () => {
  const token = 'Xq3_aB-9kLmNoPqRsTuVwXyZ';
  it('puts only a random code in a link to the company address', () => {
    expect(badgeUrl('https://13-247-19-106.sslip.io/', token)).toBe(`https://13-247-19-106.sslip.io/b/${token}`);
    expect(isBadgeToken(token)).toBe(true);
    expect(isBadgeToken('short')).toBe(false);
  });
  it('reads a badge from any address, and still reads older cards', () => {
    expect(parseCardQr(`https://onpar.co.za/b/${token}`)).toEqual({ kind: 'badge', token });
    expect(parseCardQr(` http://localhost:3000/b/${token}/ `)).toEqual({ kind: 'badge', token });
    expect(parseCardQr('ONPAR-ID:BCD123GP')).toEqual({ kind: 'tsf', tsfNumber: 'BCD123GP' });
  });
  it('refuses checkpoint codes and other links', () => {
    expect(parseCardQr(`https://onpar.co.za/p/${token}`)).toBeNull();
    expect(parseCardQr(`https://onpar.co.za/b/${token}x`)).toBeNull();
    expect(parseCardQr('hello')).toBeNull();
  });
});
