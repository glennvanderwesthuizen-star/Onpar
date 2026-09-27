import { percent, reportOverdue, unfilledPosts } from './index';

describe('dashboard figures (section 6.11)', () => {
  const at = (s: string) => new Date(s);
  it('counts a Red report overdue after a day, Green after a week', () => {
    const reported = at('2026-09-20T08:00:00+02:00');
    expect(reportOverdue('red', reported, at('2026-09-21T07:59:00+02:00'))).toBe(false);
    expect(reportOverdue('red', reported, at('2026-09-21T08:01:00+02:00'))).toBe(true);
    expect(reportOverdue('green', reported, at('2026-09-26T08:00:00+02:00'))).toBe(false);
    expect(reportOverdue('green', reported, at('2026-09-27T08:01:00+02:00'))).toBe(true);
  });
  it('counts unfilled posts only after the start plus grace', () => {
    expect(unfilledPosts(3, 1, '2026-09-27', '06:00', at('2026-09-27T06:05:00+02:00'), 5)).toBe(0);
    expect(unfilledPosts(3, 1, '2026-09-27', '06:00', at('2026-09-27T06:06:00+02:00'), 5)).toBe(2);
    expect(unfilledPosts(2, 3, '2026-09-27', '06:00:00', at('2026-09-27T09:00:00+02:00'), 5)).toBe(0);
    // A night shift has not started yet in the afternoon.
    expect(unfilledPosts(2, 0, '2026-09-27', '18:00', at('2026-09-27T15:00:00+02:00'), 5)).toBe(0);
  });
  it('gives whole percentages, or nothing when nothing is due', () => {
    expect(percent(2, 3)).toBe(67);
    expect(percent(0, 0)).toBeNull();
  });
});
