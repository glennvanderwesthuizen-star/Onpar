# On Par: load test

Run on 27 September 2026 (Milestone 10) with `pnpm --filter @onpar/api load:test`. The server, database and load generator all ran on one 4-core machine, so real hosting will do better. The script wipes and rebuilds its own `onpar_load` database.

## The data

A large company: 60 sites, 500 officers, 120 post phones and a full year of history. That comes to:
- 130,000 shifts
- 130,000 performance events
- 110,000 task occurrences
- 520,000 patrols
- 5,000 reports
- 200,000 audit entries

## Results

**Morning rush:** 120 guards sign in and press Duty On at the same moment. That is 240 PIN checks, which are deliberately slow for security. All succeeded; the slowest took 1.2 seconds.

**Each request alone** (median of 5):

| Request | Time |
|---|---|
| Device heartbeat, patrol scan, guard's tasks and score | 3–6 ms |
| Attendance, reports, training, patrol alerts | 4–11 ms |
| Scores list (500 officers) | 23 ms |
| Dashboard: one site / a supervisor's sites / whole company | 24 / 25 / 48 ms |

**Sustained overload:** 50 users sending requests back-to-back with no pause, for 30 seconds, in the mix a busy company would produce (phones and managers).
- 216 requests per second.
- **0 errors.**
- Each request waited 0.2–0.4 seconds, because the single server was at full capacity.

Expected pilot traffic is about 2–5 requests per second, which gives roughly **40 times headroom**.

## Fixed along the way

- The company dashboard took **472 ms** on its own. Looking up "one day" of patrols and reports converted every row's time before comparing, which meant reading half a million patrols. Days are now looked up as a time range with new indexes (migration 0013), and score events are grouped by officer once. It now takes **48 ms**, and capacity went from 83 to 216 requests per second.

## Later, if needed

- Run more than one server behind the load balancer. Before that, move the scheduled jobs to a single worker (OPERATIONS.md).
- Cache the company dashboard for about 30 seconds if many managers keep it open.
