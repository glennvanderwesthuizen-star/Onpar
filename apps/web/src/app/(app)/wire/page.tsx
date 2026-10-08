'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { bobWireMonthsTo, mergeWire } from '@onpar/rules';
import { ErrorBanner, Field, Pill, formatDate, useLoad } from '@/components/ui';
import { WireApprovals } from '@/components/WireApprovals';
import { WireStore } from '@/components/WireStore';
import { WireBoard } from '@/components/WireBoard';

/**
 * The Wire: the guard reward programme (owner's rule book of 8 Oct 2026). For the owner this is
 * the calibration page: what guards are really earning, how fast they will reach silver and gold,
 * and what other values would have paid over the same months.
 */

type Rule = string;
interface Settings {
  readyLeadMinutes: number;
  barbs: Record<string, number>;
  standardScore: number;
  improvementMargin: number;
  silver: number;
  gold: number;
  entryBands: { from: number; barbs: number }[];
  launchCreditPerYear: number;
  randPerBarb: number;
  notesPaidPerMonth: number;
  discretionaryBudgetPerSite: number;
  storeOpen: boolean;
  coursesPerYear: number;
  weights: Record<string, number>;
}
interface GuardRow {
  employeeId: string;
  name: string;
  employeeNumber: string;
  site: string;
  active: boolean;
  joinedOn: string;
  recruitmentScore: number | null;
  showName: boolean;
  insignia: 'black' | 'silver' | 'gold';
  wireTotal: number;
  launchCredit: number;
  available: number;
  thisMonth: { total: number; bySource: Record<Rule, number> };
  streak: number;
  months: { month: string; score: number | null; award: string | null; barbs: number }[];
  pace: number;
  monthsToSilver: number | null;
  monthsToGold: number | null;
}
interface Overview {
  startedOn: string;
  today: string;
  settings: Settings;
  canManage: boolean;
  rules: { key: Rule; label: string }[];
  insignia: Record<string, string>;
  guards: GuardRow[];
  months: { month: string; total: number; bySource: Record<Rule, number> }[];
  bob: { shifts: number; monthsToSilver: number; monthsToGold: number };
}
interface SimResult {
  months: string[];
  guards: {
    name: string;
    site: string | null;
    current: SimGuard;
    proposed: SimGuard;
  }[];
}
interface SimGuard {
  total: number;
  pace: number;
  monthsToSilver: number | null;
  monthsToGold: number | null;
  months: { month: string; barbs: number; score: number | null; award: string | null }[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const num = (n: number) => n.toLocaleString('en-ZA');
const rand = (n: number) => `R${Math.round(n).toLocaleString('en-ZA')}`;
function inMonths(n: number | null): string {
  if (n === null) return 'Not earning yet';
  if (n === 0) return 'Reached';
  if (n < 12) return `${n} month${n === 1 ? '' : 's'}`;
  const y = n / 12;
  return `${n} months (${y.toFixed(1)} years)`;
}
const insigniaTone = (i: string) => (i === 'gold' ? 'amber' : i === 'silver' ? 'blue' : 'grey');

const BARB_FIELDS: { key: string; label: string }[] = [
  { key: 'readyForDuty', label: 'Ready for duty, per shift' },
  { key: 'dutiesComplete', label: 'Duties complete, per shift' },
  { key: 'cleanHandover', label: 'Clean handover, per shift' },
  { key: 'improvement', label: 'Improvement award, per month' },
  { key: 'standardStart', label: 'Standard award, first month' },
  { key: 'standardStep', label: 'Standard award, added each month in a row' },
  { key: 'standardCap', label: 'Standard award, most per month' },
  { key: 'longServiceMonthly', label: 'Long service, per month worked' },
  { key: 'anniversary', label: 'Anniversary, each year' },
  { key: 'newSkill', label: 'New skill (course or grade)' },
  { key: 'thuthukaSent', label: 'Thuthuka note sent' },
  { key: 'thuthukaAdopted', label: 'Thuthuka note adopted' },
  { key: 'customerPraise', label: 'Customer praise' },
  { key: 'discretionaryMin', label: 'Recognition award, least' },
  { key: 'discretionaryMax', label: 'Recognition award, most' },
];

export default function WirePage() {
  const { data, error, reload } = useLoad(() => api<Overview>('/wire'));
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);

  if (error) return <ErrorBanner error={error} />;
  if (!data) return <p className="mute">Loading…</p>;
  const s = data.settings;
  const totalIssued = data.months.reduce((a, m) => a + m.total, 0);
  const goldTooSoon = data.bob.monthsToGold < 36;

  const runNow = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ shifts: number; months: number }>('/wire/run', { method: 'POST' });
      setMsg(`Done: ${r.shifts} new shift barb${r.shifts === 1 ? '' : 's'}, ${r.months} month-end run${r.months === 1 ? '' : 's'}.`);
      reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="head">
        <div>
          <h1>The Wire</h1>
          <p className="mute">
            The guard reward programme. Barbs are worked out from what On Par already records and are never taken away. Running since {formatDate(data.startedOn)}. Guards see their
            own Wire on the post phone under My Wire.
          </p>
        </div>
        {data.canManage && (
          <button className="btn ghost" onClick={runNow} disabled={busy}>
            {busy ? 'Working…' : 'Work out barbs now'}
          </button>
        )}
      </div>
      <ErrorBanner error={err} />
      {msg && <div className="banner ok">{msg}</div>}

      <div className={`banner ${goldTooSoon ? 'warn' : 'ok'}`}>
        <b>Bob Wire</b>, earning every barb on {data.bob.shifts} shifts a month, would reach silver in {inMonths(data.bob.monthsToSilver)} and gold in {inMonths(data.bob.monthsToGold)}.
        {goldTooSoon ? ' That is under three years: raise the gold threshold or lower some values.' : ' Nobody can reach gold sooner than that.'}
      </div>

      <WireApprovals guards={data.guards.filter((g) => g.active)} changed={reload} />

      <div className="card scroll">
        <h2>Guards</h2>
        <p className="mute small">
          Pace is the average barbs a month over his last three finished months. Silver and gold show how long he needs at that pace. Tap a guard to see every barb and to set when he
          joined and his recruitment score.
        </p>
        {!data.guards.length && <p className="mute">No guards yet.</p>}
        {!!data.guards.length && (
          <table>
            <thead>
              <tr>
                <th>Guard</th>
                <th>Insignia</th>
                <th>The Wire</th>
                <th>Available</th>
                <th>This month</th>
                <th>Pace a month</th>
                <th>Silver in</th>
                <th>Gold in</th>
                <th>Months at the standard</th>
              </tr>
            </thead>
            <tbody>
              {data.guards.map((g) => (
                <GuardLines key={g.employeeId} g={g} data={data} open={open === g.employeeId} toggle={() => setOpen(open === g.employeeId ? null : g.employeeId)} saved={reload} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card scroll">
        <h2>Barbs issued by month</h2>
        <p className="mute small">
          {num(totalIssued)} barbs issued so far, {rand(totalIssued * s.randPerBarb)} at R{s.randPerBarb} a barb. The rand value is for the company only; guards never see it.
        </p>
        {!data.months.length && <p className="mute">No barbs yet. They start when guards come on duty and go off duty at a site.</p>}
        {!!data.months.length && (
          <table>
            <thead>
              <tr>
                <th>Earned for</th>
                {data.months.map((m) => (
                  <th key={m.month}>{monthLabel(m.month)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rules
                .filter((r) => data.months.some((m) => m.bySource[r.key]))
                .map((r) => (
                  <tr key={r.key}>
                    <td>{r.label}</td>
                    {data.months.map((m) => (
                      <td key={m.month}>{m.bySource[r.key] ? num(m.bySource[r.key]) : ''}</td>
                    ))}
                  </tr>
                ))}
              <tr>
                <td>
                  <b>Total</b>
                </td>
                {data.months.map((m) => (
                  <td key={m.month}>
                    <b>{num(m.total)}</b>
                    <div className="mute small">{rand(m.total * s.randPerBarb)}</div>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        )}
      </div>

      <WireBoard />

      <WireStore canManage={data.canManage} settings={data.settings as unknown as Record<string, unknown>} saved={reload} />

      <Values key={JSON.stringify(data.settings)} data={data} saved={reload} />
    </>
  );
}

function GuardLines({ g, data, open, toggle, saved }: { g: GuardRow; data: Overview; open: boolean; toggle: () => void; saved: () => void }) {
  return (
    <>
      <tr className="link" onClick={toggle}>
        <td>
          <b>{g.name}</b>
          <div className="mute small">
            {g.employeeNumber} · {g.site}
            {!g.active && ' · left'}
          </div>
        </td>
        <td>
          <Pill tone={insigniaTone(g.insignia)}>{data.insignia[g.insignia]}</Pill>
        </td>
        <td>
          {num(g.wireTotal)}
          {g.launchCredit > 0 && <div className="mute small">incl. {num(g.launchCredit)} for service</div>}
        </td>
        <td>{num(g.available)}</td>
        <td>{num(g.thisMonth.total)}</td>
        <td>{num(g.pace)}</td>
        <td>{inMonths(g.monthsToSilver)}</td>
        <td>{inMonths(g.monthsToGold)}</td>
        <td>{g.streak}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={9}>
            <GuardDetail id={g.employeeId} data={data} saved={saved} />
          </td>
        </tr>
      )}
    </>
  );
}

function GuardDetail({ id, data, saved }: { id: string; data: Overview; saved: () => void }) {
  const { data: g, error, reload } = useLoad(() => api<GuardRow & { entries: { date: string; rule: Rule; barbs: number; note: string; kind: string }[] }>(`/wire/guards/${id}`), [id]);
  const [joined, setJoined] = useState('');
  const [score, setScore] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    if (g) {
      setJoined(g.joinedOn);
      setScore(g.recruitmentScore === null ? '' : String(g.recruitmentScore));
    }
  }, [g]);
  if (error) return <ErrorBanner error={error} />;
  if (!g) return <p className="mute">Loading…</p>;
  const label = (r: Rule) => data.rules.find((x) => x.key === r)?.label ?? r;
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/wire/guards/${id}/profile`, { method: 'PUT', json: { joinedOn: joined, recruitmentScore: score === '' ? null : Number(score), showName: g.showName } });
      reload();
      saved();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid g2" style={{ padding: '6px 0' }} onClick={(e) => e.stopPropagation()}>
      <div>
        <h3>His months</h3>
        {!g.months.length && <p className="mute small">No finished months yet.</p>}
        {g.months.map((m) => (
          <div key={m.month} className="small">
            {monthLabel(m.month)}: {num(m.barbs)} barbs{m.score !== null && `, score ${m.score}%`}
            {m.award === 'standard' ? ', standard award' : m.award === 'improvement' ? ', improvement award' : ''}
          </div>
        ))}
        {data.canManage && (
          <>
            <h3 style={{ marginTop: 14 }}>Joining and recruitment</h3>
            <ErrorBanner error={err} />
            <div className="grid g2">
              <Field label="Joined the company" hint="Sets long service, anniversaries and the barbs for service before The Wire.">
                <input type="date" value={joined} onChange={(e) => setJoined(e.target.value)} />
              </Field>
              <Field label="Recruitment score (%)" hint="Entry barbs are paid once, the first time a score is saved.">
                <input inputMode="numeric" value={score} onChange={(e) => setScore(e.target.value.replace(/\D/g, '').slice(0, 3))} />
              </Field>
            </div>
            <button className="btn" onClick={save} disabled={busy || !joined}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
      </div>
      <div>
        <h3>Every barb</h3>
        <div style={{ maxHeight: 280, overflow: 'auto' }}>
          {!g.entries.length && <p className="mute small">None yet.</p>}
          {g.entries.map((e, i) => (
            <div key={i} className="small">
              {formatDate(e.date)} · {e.kind === 'handed_in' ? 'Handed in' : e.kind === 'returned' ? 'Given back' : label(e.rule)} · <b>{e.kind === 'handed_in' ? '−' : '+'}{e.barbs}</b>
              {e.note && <span className="mute"> · {e.note}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The values in force, and a way to try others against the real months before saving them. */
function Values({ data, saved }: { data: Overview; saved: () => void }) {
  const [v, setV] = useState<Settings>(data.settings);
  const months = useMemo(() => {
    const out: string[] = [];
    let m = data.startedOn.slice(0, 7);
    const end = data.today.slice(0, 7);
    while (m <= end) {
      out.push(m);
      const [y, mm] = m.split('-').map(Number);
      m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
    }
    return out;
  }, [data.startedOn, data.today]);
  const lastFinished = months.length > 1 ? months[months.length - 2] : months[0];
  const [from, setFrom] = useState(months[0]);
  const [to, setTo] = useState(lastFinished);
  const [sim, setSim] = useState<SimResult | null>(null);
  const [busy, setBusy] = useState<'try' | 'save' | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [savedMsg, setSavedMsg] = useState(false);
  const [started, setStarted] = useState(data.startedOn);
  const changed = JSON.stringify(v) !== JSON.stringify(data.settings) || started !== data.startedOn;
  const setBarb = (k: string, n: number) => setV({ ...v, barbs: { ...v.barbs, [k]: n } });
  const intIn = (value: number, onChange: (n: number) => void) => (
    <input inputMode="numeric" value={String(value)} onChange={(e) => onChange(Number(e.target.value.replace(/[^\d]/g, '') || 0))} />
  );

  const tryIt = async () => {
    setBusy('try');
    setErr(null);
    try {
      setSim(await api<SimResult>('/wire/simulate', { method: 'POST', json: { settings: v, from, to } }));
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy('save');
    setErr(null);
    try {
      await api('/wire/settings', { method: 'PUT', json: started !== data.startedOn ? { ...v, startedOn: started } : v });
      setSavedMsg(true);
      saved();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };
  const sum = (k: 'current' | 'proposed') => (sim ? sim.guards.reduce((a, g) => a + g[k].months.reduce((x, m) => x + m.barbs, 0), 0) : 0);

  return (
    <div className="card">
      <h2>Values, and what if they were different</h2>
      <p className="mute small">
        Change any value, then tap <b>Try these values</b> to replay the real months under them and compare with what was paid. Trying writes nothing. The replay covers the barbs paid automatically, not notes and awards decided by a person.
        {data.canManage && ' Saving makes them the values in force from the next shift and month end; barbs already earned stay as they are.'}
      </p>
      <ErrorBanner error={err} />
      {savedMsg && !changed && <div className="banner ok">Saved. The new values apply from now on.</div>}
      <h3>Barbs</h3>
      <div className="grid g3">
        {BARB_FIELDS.map((f) => (
          <Field key={f.key} label={f.label}>
            {intIn(v.barbs[f.key], (n) => setBarb(f.key, n))}
          </Field>
        ))}
      </div>
      <h3>Thresholds</h3>
      <div className="grid g3">
        <Field label="Silver barb at">{intIn(v.silver, (n) => setV({ ...v, silver: n }))}</Field>
        <Field label="Gold barb at">{intIn(v.gold, (n) => setV({ ...v, gold: n }))}</Field>
        <Field label="The standard, monthly score (%)">{intIn(v.standardScore, (n) => setV({ ...v, standardScore: n }))}</Field>
        <Field label="Improvement needed (percentage points)">{intIn(v.improvementMargin, (n) => setV({ ...v, improvementMargin: n }))}</Field>
        <Field label="Ready for duty: minutes before the start">{intIn(v.readyLeadMinutes, (n) => setV({ ...v, readyLeadMinutes: n }))}</Field>
        <Field label="Service before The Wire, barbs per year">{intIn(v.launchCreditPerYear, (n) => setV({ ...v, launchCreditPerYear: n }))}</Field>
        <Field label="Company cost of one barb (R)">{intIn(v.randPerBarb, (n) => setV({ ...v, randPerBarb: n }))}</Field>
        <Field label="Thuthuka notes paid each month">{intIn(v.notesPaidPerMonth, (n) => setV({ ...v, notesPaidPerMonth: n }))}</Field>
        <Field label="Recognition barbs per site per month">{intIn(v.discretionaryBudgetPerSite, (n) => setV({ ...v, discretionaryBudgetPerSite: n }))}</Field>
        {data.canManage && (
          <Field label="The Wire started on" hint="Shifts from this day earn barbs. Set it earlier to count shifts already worked; barbs already paid stay.">
            <input type="date" value={started} max={data.today} onChange={(e) => setStarted(e.target.value)} />
          </Field>
        )}
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <Field label="Replay from">
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            {months.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="to">
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            {months.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="row">
        <button className="btn" onClick={tryIt} disabled={!!busy}>
          {busy === 'try' ? 'Working…' : 'Try these values'}
        </button>
        {data.canManage && (
          <button className="btn ghost" onClick={save} disabled={!!busy || !changed}>
            {busy === 'save' ? 'Saving…' : 'Save as the values in force'}
          </button>
        )}
        {changed && (
          <button className="btn ghost" onClick={() => { setV(data.settings); setStarted(data.startedOn); }} disabled={!!busy}>
            Undo my changes
          </button>
        )}
      </div>
      {sim && (
        <div className={`banner ${bobWireMonthsTo(v.gold, data.bob.shifts, mergeWire(v)) < 36 ? 'warn' : 'ok'}`} style={{ marginTop: 14 }}>
          With these values Bob Wire would reach silver in {inMonths(bobWireMonthsTo(v.silver, data.bob.shifts, mergeWire(v)))} and gold in{' '}
          {inMonths(bobWireMonthsTo(v.gold, data.bob.shifts, mergeWire(v)))}.
        </div>
      )}
      {sim && <SimTable sim={sim} rand={v.randPerBarb} currentRand={data.settings.randPerBarb} totals={{ current: sum('current'), proposed: sum('proposed') }} />}
    </div>
  );
}

function SimTable({ sim, rand: r, currentRand, totals }: { sim: SimResult; rand: number; currentRand: number; totals: { current: number; proposed: number } }) {
  if (!sim.guards.length) return <p className="mute">No guard worked in those months.</p>;
  return (
    <div className="scroll" style={{ marginTop: 14 }}>
      <p>
        Over {sim.months.length === 1 ? monthLabel(sim.months[0]) : `${monthLabel(sim.months[0])} to ${monthLabel(sim.months[sim.months.length - 1])}`}: <b>{num(totals.current)}</b> barbs ({rand(totals.current * currentRand)}) on
        today&apos;s values, <b>{num(totals.proposed)}</b> ({rand(totals.proposed * r)}) on these.
      </p>
      <table>
        <thead>
          <tr>
            <th>Guard</th>
            <th>Barbs a month, now</th>
            <th>With these values</th>
            <th>Silver in, now</th>
            <th>With these values</th>
            <th>Gold in, now</th>
            <th>With these values</th>
          </tr>
        </thead>
        <tbody>
          {sim.guards.map((g) => (
            <tr key={g.name}>
              <td>
                <b>{g.name}</b>
                <div className="mute small">{g.site}</div>
              </td>
              <td>{num(g.current.pace)}</td>
              <td>
                <b>{num(g.proposed.pace)}</b>
              </td>
              <td>{inMonths(g.current.monthsToSilver)}</td>
              <td>
                <b>{inMonths(g.proposed.monthsToSilver)}</b>
              </td>
              <td>{inMonths(g.current.monthsToGold)}</td>
              <td>
                <b>{inMonths(g.proposed.monthsToGold)}</b>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
