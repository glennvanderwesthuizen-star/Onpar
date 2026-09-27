/**
 * Load test (Milestone 10). Builds a year of history for a large company in a
 * separate database, then measures response times under a morning Duty On rush
 * and a sustained mix of device and management traffic well above pilot levels.
 *
 *   pnpm --filter @onpar/api load:test            (needs the onpar_load database)
 *   LOAD_SECONDS=120 LOAD_USERS=80 pnpm --filter @onpar/api load:test
 *
 * Never point it at a real database: it wipes the one it is given.
 */
import 'reflect-metadata';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { hash } from '@node-rs/argon2';
import { createApp } from '../src/main';
import { migrate } from '../src/db/migrate';

const OWNER_URL = process.env.LOAD_DATABASE_OWNER_URL ?? 'postgres://onpar_owner:onpar_owner_dev@localhost:5432/onpar_load';
const APP_URL = process.env.LOAD_DATABASE_URL ?? 'postgres://onpar_app:onpar_app_dev@localhost:5432/onpar_load';
const SITES = 60;
const OFFICERS = 500;
const DEVICES_PER_SITE = 2;
const DAYS = 365;
const SECONDS = Number(process.env.LOAD_SECONDS ?? 60);
const USERS = Number(process.env.LOAD_USERS ?? 50);
const PIN = '482915';
const PASSWORD = 'load test password';

const deviceToken = (n: number) => `load-device-token-${n}`;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

async function seed() {
  if (!/onpar_load/.test(OWNER_URL)) throw new Error('Refusing to wipe a database whose name is not onpar_load.');
  const c = new Client({ connectionString: OWNER_URL });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT USAGE ON SCHEMA public TO onpar_app;');
  await c.end();
  await migrate(OWNER_URL, () => undefined);
  const db = new Client({ connectionString: OWNER_URL });
  await db.connect();
  const q = (sql: string, p: unknown[] = []) => db.query(sql, p);
  const t0 = Date.now();
  const pwHash = await hash(PASSWORD);
  const pinHash = await hash(PIN);
  await q('SET TIME ZONE \'Africa/Johannesburg\'');

  const { id: company } = (await q(`INSERT INTO companies (name) VALUES ('Load Test Security') RETURNING id`)).rows[0];
  await q(`INSERT INTO users (company_id, email, full_name, password_hash, role) VALUES ($1, 'manager@load.test', 'Load Manager', $2, 'company_manager')`, [company, pwHash]);
  await q(
    `INSERT INTO sites (company_id, name, address, client, minimum_grade, armed)
     SELECT $1, 'Site ' || lpad(i::text, 3, '0'), 'Address ' || i, 'Client ' || i, 'D', i % 10 = 0 FROM generate_series(1, $2) i`,
    [company, SITES],
  );
  await q(
    `INSERT INTO site_shifts (company_id, site_id, name, kind, start_time, end_time, guards_required, patrol_points)
     SELECT $1, s.id, x.name, x.kind, x.st, x.en, 4, 6 FROM sites s,
            (VALUES ('Day', 'day', time '06:00', time '18:00'), ('Night', 'night', time '18:00', time '06:00')) AS x(name, kind, st, en)`,
    [company],
  );
  // Ten supervisors, six sites each.
  await q(
    `INSERT INTO users (company_id, email, full_name, password_hash, role)
     SELECT $1, 'supervisor' || i || '@load.test', 'Supervisor ' || i, $2, 'site_supervisor' FROM generate_series(1, 10) i`,
    [company, pwHash],
  );
  await q(
    `INSERT INTO user_sites (company_id, user_id, site_id)
     SELECT $1, u.id, s.id FROM (SELECT id, row_number() OVER (ORDER BY email) - 1 AS n FROM users WHERE role = 'site_supervisor') u
       JOIN (SELECT id, row_number() OVER (ORDER BY name) - 1 AS n FROM sites) s ON s.n / 6 = u.n`,
    [company],
  );
  await q(
    `INSERT INTO employees (company_id, employee_number, full_name, id_number_enc, id_number_hmac, id_number_last4, date_of_birth, cell_number,
                            next_of_kin_name, next_of_kin_number, psira_number, psira_grade, psira_expiry, home_site_id, pin_hash)
     SELECT $1, lpad(i::text, 4, '0'), 'Officer ' || i, 'x', md5(i::text), lpad((i % 10000)::text, 4, '0'), date '1990-01-01', '082 000 0000',
            'Kin', '082 000 0001', 'PS' || i, 'C', current_date + (i % 700) - 20,
            (SELECT id FROM sites ORDER BY name OFFSET (i - 1) % $2 LIMIT 1), $3
       FROM generate_series(1, $4) i`,
    [company, SITES, pinHash, OFFICERS],
  );
  await q(
    `INSERT INTO qualifications (company_id, employee_id, type, name, completion_date, expiry_date)
     SELECT $1, id, 'first_aid', 'First aid level 1', current_date - 400, current_date + (abs(hashtext(id::text)) % 900) - 30 FROM employees`,
    [company],
  );
  await q(
    `INSERT INTO devices (company_id, label, serial_or_imei, site_id, post_name, status, last_seen_at, token_hash)
     SELECT $1, 'Device ' || lpad(n::text, 3, '0'), 'IMEI' || n, s.id, 'Post ' || p, 'active', now(), encode(sha256(('load-device-token-' || n)::bytea), 'hex')
       FROM (SELECT id, row_number() OVER (ORDER BY name) AS k FROM sites) s, generate_series(1, $2) p, LATERAL (SELECT (s.k - 1) * $2 + p AS n) x`,
    [company, DEVICES_PER_SITE],
  );
  // Patrols: one type per site, rules for both shifts, five points each.
  await q(`INSERT INTO patrol_types (company_id, site_id, code, name) SELECT $1, id, 'A', 'Internal' FROM sites`, [company]);
  await q(
    `INSERT INTO patrol_rules (company_id, patrol_type_id, shift_id, per_shift, min_gap_minutes, max_duration_minutes)
     SELECT $1, t.id, sh.id, 6, 30, 60 FROM patrol_types t JOIN site_shifts sh ON sh.site_id = t.site_id`,
    [company],
  );
  await q(
    `INSERT INTO patrol_points (company_id, site_id, patrol_type_id, name, qr_code, lat, lng, sort_order)
     SELECT $1, t.site_id, t.id, 'Point ' || p, 'QR-' || t.id || '-' || p, -26.1 + p * 0.0001, 28.05, p FROM patrol_types t, generate_series(1, 5) p`,
    [company],
  );
  // Tasks: five daily post tasks per site, a year of occurrences.
  await q(
    `INSERT INTO tasks (company_id, site_id, title, assignee_type, assignee_device_id, recurrence, start_date, generated_through)
     SELECT $1, d.site_id, 'Task ' || n, 'post', d.id, 'daily', current_date - $2::int, current_date
       FROM (SELECT DISTINCT ON (site_id) id, site_id FROM devices ORDER BY site_id, label) d, generate_series(1, 5) n`,
    [company, DAYS],
  );
  // A year of attendance: five shifts a week per officer, even officers on days, odd on nights; about 1 in 10 late.
  await q(
    `INSERT INTO attendance (company_id, employee_id, site_id, shift_id, shift_name, shift_date, scheduled_start, scheduled_end, duty_on_at, duty_from_at,
                             arrival_status, late_minutes, departure_status)
     SELECT $1, e.id, e.home_site_id, sh.id, sh.name, d::date,
            d + sh.start_time, d + sh.start_time + interval '12 hours',
            d + sh.start_time + CASE WHEN g % 10 = 0 THEN interval '17 minutes' ELSE interval '-3 minutes' END,
            d + sh.start_time + interval '12 hours 2 minutes',
            CASE WHEN g % 10 = 0 THEN 'LATE' ELSE 'ON_TIME' END, CASE WHEN g % 10 = 0 THEN 17 ELSE 0 END, 'ON_TIME'
       FROM (SELECT id, home_site_id, row_number() OVER (ORDER BY employee_number) AS k FROM employees) e
       JOIN site_shifts sh ON sh.site_id = e.home_site_id AND sh.kind = CASE WHEN e.k % 2 = 0 THEN 'day' ELSE 'night' END,
            generate_series(current_date - $2::int, current_date - 1, interval '1 day') d,
            LATERAL (SELECT (e.k + (d::date - current_date)) AS g) x
      WHERE (e.k + extract(doy FROM d)::int) % 7 < 5`,
    [company, DAYS],
  );
  await q(
    `INSERT INTO task_occurrences (company_id, task_id, site_id, occurrence_date, title, instructions, photo_required, assignee_type, assignee_device_id,
                                   state, done_by, done_at)
     SELECT $1, t.id, t.site_id, d::date, t.title, '', false, 'post', t.assignee_device_id,
            CASE WHEN abs(hashtext(t.id::text || d::text)) % 20 = 0 THEN 'missed' ELSE 'completed' END,
            CASE WHEN abs(hashtext(t.id::text || d::text)) % 20 = 0 THEN NULL
                 ELSE (SELECT a.employee_id FROM attendance a WHERE a.site_id = t.site_id AND a.shift_date = d::date LIMIT 1) END,
            CASE WHEN abs(hashtext(t.id::text || d::text)) % 20 = 0 THEN NULL ELSE d + time '09:00' END
       FROM tasks t, generate_series(current_date - $2::int, current_date - 1, interval '1 day') d`,
    [company, DAYS],
  );
  await q(
    `UPDATE task_occurrences SET state = 'missed', done_at = NULL WHERE state = 'completed' AND done_by IS NULL`,
  );
  // Today's occurrences, still open.
  await q(
    `INSERT INTO task_occurrences (company_id, task_id, site_id, occurrence_date, title, instructions, photo_required, assignee_type, assignee_device_id)
     SELECT $1, t.id, t.site_id, current_date, t.title, '', false, 'post', t.assignee_device_id FROM tasks t`,
    [company],
  );
  await q(
    `INSERT INTO performance_events (company_id, employee_id, site_id, event_date, event_type, impact, source_type, source_id, evidence, created_by_type)
     SELECT $1, employee_id, site_id, shift_date, CASE WHEN arrival_status = 'LATE' THEN 'late' ELSE 'on_time' END,
            CASE WHEN arrival_status = 'LATE' THEN -1 ELSE 1 END, 'attendance', id, 'Arrival', 'system' FROM attendance`,
    [company],
  );
  // Four patrols per shift, one in twelve missed.
  await q(
    `INSERT INTO patrol_instances (id, company_id, site_id, patrol_type_id, attendance_id, employee_id, window_index, window_start, window_end, state,
                                   started_at, finished_at, max_duration_minutes, points_earned)
     SELECT gen_random_uuid(), $1, a.site_id, t.id, a.id, a.employee_id, w, a.scheduled_start + w * interval '2 hours',
            a.scheduled_start + (w + 1) * interval '2 hours',
            CASE WHEN abs(hashtext(a.id::text || w)) % 12 = 0 THEN 'missed' ELSE 'completed' END,
            CASE WHEN abs(hashtext(a.id::text || w)) % 12 = 0 THEN NULL ELSE a.scheduled_start + w * interval '2 hours' + interval '10 minutes' END,
            CASE WHEN abs(hashtext(a.id::text || w)) % 12 = 0 THEN NULL ELSE a.scheduled_start + w * interval '2 hours' + interval '40 minutes' END,
            60, 1
       FROM attendance a JOIN patrol_types t ON t.site_id = a.site_id, generate_series(0, 3) w`,
    [company],
  );
  await q(
    `INSERT INTO reports (company_id, number, site_id, category, priority, description, stage, colour_slot, reported_by_employee, source, reported_at, closed_at)
     SELECT $1, n, a.site_id, 'maintenance', (ARRAY['green','amber','red'])[1 + n % 3], 'Report ' || n,
            CASE WHEN n > 4950 THEN 'assigned' ELSE 'closed' END, n % 10, a.employee_id, 'guard', a.duty_on_at + interval '1 hour',
            CASE WHEN n > 4950 THEN NULL ELSE a.duty_on_at + interval '3 days' END
       FROM generate_series(1, 5000) n, LATERAL (SELECT * FROM attendance OFFSET (n * 23) % 100000 LIMIT 1) a`,
    [company],
  );
  await q(
    `INSERT INTO audit_log (company_id, actor_type, actor_label, action, entity_type, at)
     SELECT $1, 'system', 'Load', 'load.seed', 'company', now() - (n || ' minutes')::interval FROM generate_series(1, 200000) n`,
    [company],
  );
  await q('ANALYZE');
  const counts = (
    await q(`SELECT relname, n_live_tup::int AS n FROM pg_stat_user_tables WHERE n_live_tup > 1000 ORDER BY n_live_tup DESC`)
  ).rows;
  await db.end();
  return { company, seconds: (Date.now() - t0) / 1000, counts };
}

type Sample = { ms: number; status: number };
const samples = new Map<string, Sample[]>();
function record(name: string, ms: number, status: number) {
  if (!samples.has(name)) samples.set(name, []);
  samples.get(name)!.push({ ms, status });
}
const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

async function main() {
  console.log(`Seeding ${SITES} sites, ${OFFICERS} officers, ${SITES * DEVICES_PER_SITE} devices and ${DAYS} days of history…`);
  const s = await seed();
  console.log(`Seeded in ${s.seconds.toFixed(0)} s:`, s.counts.map((c) => `${c.relname} ${c.n.toLocaleString('en-ZA')}`).join(', '));

  const app = await createApp({
    databaseUrl: APP_URL,
    databaseOwnerUrl: OWNER_URL,
    jwtSecret: randomBytes(32).toString('hex'),
    dataKey: randomBytes(32),
    uploadDir: mkdtempSync(join(tmpdir(), 'onpar-load-')),
    port: 0,
    webOrigin: 'http://localhost:3000',
    cookieSecure: true,
    trustProxy: 'loopback',
  });
  await app.listen(0);
  const base = (await app.getUrl()).replace('[::1]', 'localhost') + '/api';
  const call = async (name: string, method: string, path: string, headers: Record<string, string>, body?: unknown) => {
    const t = performance.now();
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    record(name, performance.now() - t, r.status);
    return { status: r.status, json: text ? JSON.parse(text) : null };
  };

  // Sign in the managers.
  const manager = (await call('sign in (manager)', 'POST', '/auth/login', {}, { email: 'manager@load.test', password: PASSWORD })).json.token;
  const supervisors: string[] = [];
  for (let i = 1; i <= 10; i++) supervisors.push((await call('sign in (manager)', 'POST', '/auth/login', {}, { email: `supervisor${i}@load.test`, password: PASSWORD })).json.token);
  const m = (t: string) => ({ Authorization: `Bearer ${t}` });

  // Morning rush: on every device a guard signs in and presses Duty On, all at once.
  const db = new Client({ connectionString: OWNER_URL });
  await db.connect();
  const devices = (
    await db.query(
      `SELECT d.label, d.site_id, (SELECT employee_number FROM employees e WHERE e.home_site_id = d.site_id ORDER BY employee_number OFFSET (right(d.label, 1)::int % 2) LIMIT 1) AS emp,
              (SELECT array_agg(qr_code) FROM patrol_points p WHERE p.site_id = d.site_id) AS codes
         FROM devices d ORDER BY label`,
    )
  ).rows;
  const sites = (await db.query('SELECT id FROM sites')).rows.map((r) => r.id as string);
  await db.end();
  const guards = await Promise.all(
    devices.map(async (d, i) => {
      const dev = { 'X-Device-Token': deviceToken(i + 1) };
      const login = await call('guard sign-in (PIN)', 'POST', '/device/login', dev, { employeeNumber: d.emp, pin: PIN });
      const g = { ...dev, Authorization: `Bearer ${login.json?.token}` };
      const now = new Date().toISOString();
      await call('Duty On (PIN)', 'POST', '/device/duty', g, { eventId: randomUUID(), kind: 'duty_on', pin: PIN, trustedAt: now, deviceClock: now });
      return { dev, g, codes: d.codes as string[] };
    }),
  );
  const rush = samples.get('Duty On (PIN)')!;
  console.log(`Morning rush: ${rush.length} Duty Ons at once, slowest ${Math.max(...rush.map((x) => x.ms)).toFixed(0)} ms, errors ${rush.filter((x) => x.status >= 500).length}`);

  // Sustained mix.
  const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
  const mix: [number, () => Promise<unknown>][] = [
    [25, () => { const g = pick(guards); return call('device heartbeat', 'POST', '/device/heartbeat', g.dev, { batteryPct: 80, appVersion: '1.0.0', kioskStatus: 'locked' }); }],
    [15, () => call('guard: today\'s tasks', 'GET', '/device/tasks', pick(guards).g)],
    [8, () => call('guard: my score', 'GET', '/device/score', pick(guards).g)],
    [20, () => {
      const g = pick(guards);
      const now = new Date().toISOString();
      return call('patrol scan', 'POST', '/device/patrols/scan', g.g, { eventId: randomUUID(), patrolId: randomUUID(), qrCode: pick(g.codes), lat: -26.1003, lng: 28.05, accuracyM: 8, trustedAt: now, deviceClock: now });
    }],
    [6, () => call('dashboard (company)', 'GET', '/dashboard', m(manager))],
    [6, () => { const i = Math.floor(Math.random() * 10); return call('dashboard (supervisor)', 'GET', '/dashboard', m(supervisors[i])); }],
    [5, () => call('dashboard (one site)', 'GET', `/dashboard/sites/${pick(sites)}`, m(manager))],
    [4, () => call('attendance list', 'GET', '/attendance', m(pick(supervisors)))],
    [3, () => call('scores list', 'GET', '/scores', m(manager))],
    [3, () => call('reports list', 'GET', '/reports', m(manager))],
    [2, () => call('training', 'GET', '/training', m(manager))],
    [3, () => call('patrol alerts', 'GET', '/patrols/alerts', m(pick(supervisors)))],
  ];
  const total = mix.reduce((a, [w]) => a + w, 0);
  const choose = () => {
    let r = Math.random() * total;
    for (const [w, f] of mix) if ((r -= w) < 0) return f;
    return mix[0][1];
  };
  // Each request alone, five times, so slow queries show without any queueing.
  console.log('\nEach request alone (median of 5):');
  for (const [, f] of mix) {
    const before = new Map([...samples].map(([k, v]) => [k, v.length]));
    for (let i = 0; i < 5; i++) await f();
    for (const [k, v] of samples) {
      const fresh = v.slice(before.get(k) ?? 0).map((x) => x.ms).sort((a, b) => a - b);
      if (fresh.length) console.log(`  ${k.padEnd(26)} ${pct(fresh, 50).toFixed(0)} ms`);
    }
  }
  samples.clear();
  console.log(`\nRunning ${USERS} simultaneous users for ${SECONDS} s…`);
  const until = Date.now() + SECONDS * 1000;
  const started = Date.now();
  let requests = 0;
  await Promise.all(
    Array.from({ length: USERS }, async () => {
      while (Date.now() < until) {
        await choose()().catch((e) => record('network error', 0, 599) ?? e);
        requests++;
      }
    }),
  );
  const elapsed = (Date.now() - started) / 1000;
  await app.close();

  console.log(`\n${requests.toLocaleString('en-ZA')} requests in ${elapsed.toFixed(0)} s = ${(requests / elapsed).toFixed(0)} per second\n`);
  console.log('Request'.padEnd(26) + 'count'.padStart(7) + 'median'.padStart(9) + 'p95'.padStart(8) + 'p99'.padStart(8) + 'max'.padStart(8) + '  refused  errors');
  for (const [name, xs] of samples) {
    const ms = xs.map((x) => x.ms).sort((a, b) => a - b);
    const refused = xs.filter((x) => x.status >= 400 && x.status < 500).length;
    const errors = xs.filter((x) => x.status >= 500).length;
    const f = (n: number) => `${n.toFixed(0)}ms`.padStart(8);
    console.log(name.padEnd(26) + String(xs.length).padStart(7) + f(pct(ms, 50)).padStart(9) + f(pct(ms, 95)) + f(pct(ms, 99)) + f(ms[ms.length - 1]) + String(refused).padStart(9) + String(errors).padStart(8));
  }
  const errors = [...samples.values()].flat().filter((x) => x.status >= 500).length;
  process.exit(errors ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
