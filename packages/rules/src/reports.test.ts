import { followUpEffect, pickColourSlot, REPORT_COLOURS, MANAGEMENT_ACTIONS } from './index';

describe('guard follow-up (section 6.6)', () => {
  it('is only possible once assigned, and not once closed', () => {
    expect(followUpEffect('reported', 'in_progress').kind).toBe('refused');
    expect(followUpEffect('closed', 'done_ok').kind).toBe('refused');
  });
  it('"Repair done, all OK" after attendance is checked completes Job inspected (scenario 8)', () => {
    expect(followUpEffect('attendance_checked', 'done_ok')).toMatchObject({ kind: 'move', to: 'job_inspected' });
    expect(followUpEffect('assigned', 'done_ok')).toEqual({ kind: 'note_only' });
  });
  it('"Not fixed" after the work was actioned sends it back to Assigned (scenario 8)', () => {
    expect(followUpEffect('actioned', 'not_fixed')).toMatchObject({ kind: 'move', to: 'assigned' });
    expect(followUpEffect('attendance_checked', 'not_fixed')).toMatchObject({ kind: 'move', to: 'assigned' });
    expect(followUpEffect('assigned', 'not_fixed')).toEqual({ kind: 'note_only' });
  });
  it('other outcomes are notes for the higher level', () => {
    expect(followUpEffect('assigned', 'not_started')).toEqual({ kind: 'note_only' });
    expect(followUpEffect('actioned', 'in_progress')).toEqual({ kind: 'note_only' });
  });
});

describe('management actions', () => {
  it('follow the stage order', () => {
    expect(MANAGEMENT_ACTIONS.actioned.from).toEqual(['assigned']);
    expect(MANAGEMENT_ACTIONS.close.from).toEqual(['job_inspected']);
  });
});

describe('report colours (section 24, scenario 16)', () => {
  it('gives open reports different colours', () => {
    expect(pickColourSlot([], 1)).toBe(0);
    expect(pickColourSlot([0], 2)).toBe(1);
    expect(pickColourSlot([0, 1, 3], 4)).toBe(2);
  });
  it('reuses a colour once its report closes', () => {
    expect(pickColourSlot([1, 2], 7)).toBe(0);
  });
  it('cycles when every colour is taken', () => {
    const all = REPORT_COLOURS.map((_, i) => i);
    expect(pickColourSlot(all, 23)).toBe(23 % REPORT_COLOURS.length);
  });
});
