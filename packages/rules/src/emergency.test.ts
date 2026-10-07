import { emergencyOptions } from './emergency';

describe('the emergency panel', () => {
  it('a site with no numbers still offers the national ones, and no armed response', () => {
    expect(emergencyOptions({}).map((o) => [o.kind, o.phone])).toEqual([
      ['police_national', '10111'],
      ['fire_national', '10177'],
      ['ambulance_national', '10177'],
    ]);
  });

  it('police has two choices when the local station is set; fire and ambulance use the local number instead of the national one', () => {
    const o = emergencyOptions({
      police_station: { name: 'Sandton SAPS', phone: '011 555 0001' },
      fire: { name: '', phone: '011 555 0002' },
      ambulance: { name: 'ER24', phone: '084 124' },
      armed_response: { name: 'Fast Response', phone: '011 555 0004' },
    });
    expect(o.map((x) => x.kind)).toEqual(['police_national', 'police_station', 'fire', 'ambulance', 'armed_response']);
    expect(o.filter((x) => x.service === 'police')).toHaveLength(2);
    expect(o.find((x) => x.kind === 'armed_response')).toMatchObject({ name: 'Fast Response', national: false });
  });

  it('a number of only spaces counts as not set', () => {
    expect(emergencyOptions({ fire: { name: 'x', phone: '  ' } }).find((x) => x.service === 'fire')?.national).toBe(true);
  });
});
