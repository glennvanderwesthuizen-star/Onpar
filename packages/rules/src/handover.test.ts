import { handoverItemErrors, handoverProblems, receiveDifferences } from './handover';

describe('shift handover', () => {
  const items = [
    { name: 'Radio', expected: 2, present: 2, damaged: false },
    { name: 'Torch', expected: 2, present: 1, damaged: false },
    { name: 'Handheld device', expected: 1, present: 1, damaged: true },
  ];
  it('lists what is missing or damaged, in plain words', () => {
    expect(handoverProblems(items)).toEqual(['Torch: 1 of 2', 'Handheld device: damaged']);
    expect(handoverProblems([items[0]])).toEqual([]);
  });
  it('compares what was received with what was handed over', () => {
    const received = items.map((i) => (i.name === 'Radio' ? { ...i, present: 1 } : i.name === 'Torch' ? { ...i, damaged: true } : i));
    expect(receiveDifferences(items, received)).toEqual(['Radio: handed over 2, received 1', 'Torch: found damaged']);
    expect(receiveDifferences(items, items)).toEqual([]);
  });
  it('checks the counts', () => {
    expect(handoverItemErrors(items)).toBeNull();
    expect(handoverItemErrors([{ ...items[0], present: -1 }])).toMatch(/whole number/);
  });
});
