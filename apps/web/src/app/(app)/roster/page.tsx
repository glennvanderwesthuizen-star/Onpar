'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { addDays, patternSymbolOn, sastDate, weekStart, weekdayIndex } from '@onpar/rules';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Field, Pill, formatDate, useLoad } from '@/components/ui';

interface SiteRow {
  id: string;
  name: string;
  client: string;
  address: string;
}

interface Cell {
  date: string;
  status: 'working' | 'off' | 'unmapped' | 'not_rostered';
  source: 'pattern' | 'change' | 'weekly' | null;
  changeId: string | null;
  siteId: string | null;
  siteName: string | null;
  shiftId?: string;
  shiftName?: string;
  kind?: 'day' | 'night';
  startTime?: string;
  endTime?: string;
  elsewhere: boolean;
}

interface Row {
  id: string;
  name: string;
  employeeNumber: string;
  grade: string;
  homeSiteName: string;
  allocation: { id: string; patternNumber: number; patternName: string; pattern: string; position: number; startDate: string; endDate: string | null } | null;
  cells: Cell[];
  clashes: { date: string; message: string }[];
}

interface ShiftReq {
  shiftId: string;
  name: string;
  kind: 'day' | 'night';
  startTime: string;
  endTime: string;
  days: { date: string; required: number; actual: number; status: 'pass' | 'short' | 'over'; changed: boolean; note: string; holiday: boolean }[];
}

interface Week {
  site: SiteRow & { minimumGrade: string; armed: boolean };
  from: string;
  to: string;
  dates: { date: string; holiday: boolean }[];
  shifts: ShiftReq[];
  rows: Row[];
  clashes: { message: string }[];
  warnings: string[];
}

interface Pattern {
  id: string;
  code: string;
  name: string;
  sequence: string[];
  description: string;
  active: boolean;
}

interface Person {
  id: string;
  name: string;
  employeeNumber: string;
  grade: string;
  homeSiteName: string;
  allocatedSiteId: string | null;
  allocatedSiteName: string | null;
  on: { status: string; siteName: string | null; shiftName: string | null };
}

interface ShiftOption {
  id: string;
  name: string;
  kind: 'day' | 'night';
  startTime: string;
  endTime: string;
  siteId: string;
  siteName: string;
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

type Panel =
  | { kind: 'change'; row: Row | null; date: string; cell: Cell | null }
  | { kind: 'requirement'; shift: ShiftReq; date: string }
  | { kind: 'allocate' }
  | null;

export default function RosterPage() {
  const { can } = useSession();
  const [mode, setMode] = useState<'current' | 'new' | null>(null);
  const [siteId, setSiteId] = useState('');
  const [from, setFrom] = useState(weekStart(sastDate(new Date())));
  const [panel, setPanel] = useState<Panel>(null);
  const sites = useLoad(() => api<SiteRow[]>('/sites'));

  // A link such as /roster?site=… opens that site straight away.
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get('site');
    if (s) {
      setMode('current');
      setSiteId(s);
    }
  }, []);

  const week = useLoad(() => (siteId ? api<Week>(`/roster/sites/${siteId}/week?from=${from}`) : Promise.resolve(null)), [siteId, from]);
  const manage = can('roster.manage');
  const done = () => {
    setPanel(null);
    week.reload();
  };

  return (
    <>
      <div className="head">
        <div>
          <h1>Roster</h1>
          <p className="mute">Choose a site to see who works which shift. Every day is worked out from each guard&rsquo;s pattern.</p>
        </div>
        <div className="row">
          <Link className="btn ghost" href="/roster/patterns">
            Shift patterns and holidays
          </Link>
        </div>
      </div>

      {/* Section 37: one strongly bordered box, nothing else until a choice is made. */}
      <div className="sitepick">
        <div className="row">
          <button className={`btn ${mode === 'current' ? '' : 'ghost'}`} onClick={() => setMode('current')} aria-pressed={mode === 'current'}>
            Current site
          </button>
          <button className={`btn ${mode === 'new' ? '' : 'ghost'}`} onClick={() => setMode('new')} aria-pressed={mode === 'new'}>
            New site
          </button>
        </div>
        {mode === 'new' && (
          <div style={{ marginTop: 12 }}>
            {can('sites.edit') ? (
              <Link className="btn" href="/sites/new?then=roster">
                Set up a new site
              </Link>
            ) : (
              <p className="mute">Ask a company manager to set up a new site.</p>
            )}
          </div>
        )}
        {mode === 'current' && (
          <div style={{ marginTop: 12 }}>
            <ErrorBanner error={sites.error} />
            <Field label="Site">
              <select
                value={siteId}
                onChange={(e) => {
                  setSiteId(e.target.value);
                  setPanel(null);
                }}
              >
                <option value="">Choose a site…</option>
                {sites.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            {week.data && (
              <div className="siteinset">
                <div>
                  <div className="sitename">{week.data.site.name}</div>
                  <div className="mute small">
                    {week.data.site.client} · {week.data.site.address}
                    {week.data.site.armed ? ' · Armed' : ''} · Minimum grade {week.data.site.minimumGrade}
                  </div>
                </div>
                <div className="row">
                  {can('sites.edit') && (
                    <Link className="btn ghost sm" href={`/sites/${siteId}`}>
                      Edit this site
                    </Link>
                  )}
                  <button className="btn ghost sm" onClick={() => setFrom(addDays(from, -7))} aria-label="Previous week">
                    ← Previous
                  </button>
                  <button className="btn ghost sm" onClick={() => setFrom(weekStart(sastDate(new Date())))}>
                    This week
                  </button>
                  <button className="btn ghost sm" onClick={() => setFrom(addDays(from, 7))} aria-label="Next week">
                    Next →
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {mode === 'current' && siteId && (
        <>
          <ErrorBanner error={week.error} />
          {!week.data && !week.error && <p className="mute">Loading…</p>}
          {week.data && (
            <>
              {week.data.clashes.map((c) => (
                <div key={c.message} className="banner err" role="alert">
                  {c.message}
                </div>
              ))}
              {week.data.rows.flatMap((r) => r.clashes).map((c) => (
                <div key={c.message} className="banner err" role="alert">
                  {c.message}
                </div>
              ))}
              {week.data.warnings.map((w) => (
                <div key={w} className="banner warn">
                  {w}
                </div>
              ))}
              <WeekTable
                week={week.data}
                manage={manage}
                onCell={(row, cell) => setPanel({ kind: 'change', row, date: cell.date, cell })}
                onRequirement={(shift, date) => setPanel({ kind: 'requirement', shift, date })}
                onEnd={async (row) => {
                  const date = window.prompt(`Take ${row.name} off this roster from which date? (YYYY-MM-DD)`, sastDate(new Date()));
                  if (!date || !row.allocation) return;
                  try {
                    await api(`/roster/allocations/${row.allocation.id}/end`, { method: 'POST', json: { endDate: date } });
                    week.reload();
                  } catch (e) {
                    window.alert(e instanceof Error ? e.message : 'Could not end the allocation.');
                  }
                }}
              />
              {!manage && (
                <div className="banner" style={{ margin: '4px 0 14px' }}>
                  You can see this roster but not change it. Allocating guards and changing days is done by a company manager,
                  site manager or supervisor. If you are the system administrator and also run the rosters, add yourself as a
                  <b> Company manager</b> on the Users page (a second sign-in, for example with yourname+manager@gmail.com) and use
                  that for rostering.
                </div>
              )}
              {manage && (
                <div className="row" style={{ margin: '4px 0 14px' }}>
                  <button className="btn" onClick={() => setPanel({ kind: 'allocate' })}>
                    Allocate a guard to this site
                  </button>
                  <button className="btn ghost" onClick={() => setPanel({ kind: 'change', row: null, date: week.data!.from, cell: null })}>
                    Add someone for one day (relief)
                  </button>
                </div>
              )}
              {panel?.kind === 'allocate' && <AllocatePanel siteId={siteId} siteName={week.data.site.name} from={week.data.from} onDone={done} onCancel={() => setPanel(null)} />}
              {panel?.kind === 'change' && (
                <ChangePanel key={`${panel.row?.id}-${panel.date}`} siteId={siteId} row={panel.row} date={panel.date} cell={panel.cell} onDone={done} onCancel={() => setPanel(null)} />
              )}
              {panel?.kind === 'requirement' && (
                <RequirementPanel key={`${panel.shift.shiftId}-${panel.date}`} shift={panel.shift} date={panel.date} onDone={done} onCancel={() => setPanel(null)} />
              )}
            </>
          )}
        </>
      )}
    </>
  );
}

function CellView({ c }: { c: Cell }) {
  const mark = c.source === 'change' ? ' •' : c.source === 'weekly' ? ' ↻' : '';
  if (c.status === 'working') {
    return (
      <span className={`rc ${c.elsewhere ? 'away' : c.kind}`} title={`${c.shiftName} ${c.startTime}–${c.endTime}${c.elsewhere ? ` at ${c.siteName}` : ''}`}>
        <b>{c.kind === 'day' ? 'D' : 'N'}</b>
        {mark}
        <small>{c.elsewhere ? c.siteName : c.shiftName}</small>
      </span>
    );
  }
  if (c.status === 'off') return <span className="rc off">Off{mark}</span>;
  if (c.status === 'unmapped')
    return (
      <span className="rc bad" title="The pattern says this shift type, but the site has no such shift.">
        ? <small>{c.siteName}</small>
      </span>
    );
  return <span className="rc none">—</span>;
}

function WeekTable({
  week,
  manage,
  onCell,
  onRequirement,
  onEnd,
}: {
  week: Week;
  manage: boolean;
  onCell: (r: Row, c: Cell) => void;
  onRequirement: (s: ShiftReq, date: string) => void;
  onEnd: (r: Row) => void;
}) {
  return (
    <div className="card scroll">
      <table className="roster">
        <thead>
          <tr>
            <th>
              {formatDate(week.from)} to {formatDate(week.to)}
            </th>
            {week.dates.map((d) => (
              <th key={d.date} className={d.holiday ? 'hol' : ''}>
                {dayLabel(d.date)}
                {d.holiday && <div className="small">Public holiday</div>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="sect">
            <td colSpan={8}>Guards needed</td>
          </tr>
          {week.shifts.map((s) => (
            <tr key={`req-${s.shiftId}`}>
              <td>
                <span className={`kind ${s.kind}`}>{s.kind === 'day' ? 'DAY' : 'NIGHT'}</span> {s.name}{' '}
                <span className="mute small">
                  {s.startTime}–{s.endTime}
                </span>
              </td>
              {s.days.map((d) => (
                <td key={d.date} className="num">
                  {manage ? (
                    <button className="cellbtn" onClick={() => onRequirement(s, d.date)} title={d.note || 'Change the number needed on this date'}>
                      {d.required}
                      {d.changed ? ' •' : ''}
                    </button>
                  ) : (
                    d.required
                  )}
                </td>
              ))}
            </tr>
          ))}
          <tr className="sect">
            <td colSpan={8}>Guards ({week.rows.length})</td>
          </tr>
          {!week.rows.length && (
            <tr>
              <td colSpan={8} className="mute">
                Nobody is rostered here this week. Allocate a guard below.
              </td>
            </tr>
          )}
          {week.rows.map((r) => (
            <tr key={r.id}>
              <td>
                <b>{r.name}</b> <span className="mute small">#{r.employeeNumber} · grade {r.grade}</span>
                <div className="mute small">
                  {r.allocation ? (
                    <>
                      Pattern {String(r.allocation.patternNumber).padStart(2, '0')} ({r.allocation.pattern}), position {r.allocation.position}, from{' '}
                      {formatDate(r.allocation.startDate)}
                      {r.allocation.endDate ? `, until ${formatDate(addDays(r.allocation.endDate, -1))}` : ''}
                      {manage && !r.allocation.endDate && (
                        <>
                          {' '}
                          ·{' '}
                          <button className="linkbtn" onClick={() => onEnd(r)}>
                            take off roster
                          </button>
                        </>
                      )}
                    </>
                  ) : (
                    <>Here for single days · home site {r.homeSiteName}</>
                  )}
                </div>
              </td>
              {r.cells.map((c) => (
                <td key={c.date}>
                  {manage ? (
                    <button className="cellbtn" onClick={() => onCell(r, c)} aria-label={`Change ${r.name} on ${dayLabel(c.date)}`}>
                      <CellView c={c} />
                    </button>
                  ) : (
                    <CellView c={c} />
                  )}
                </td>
              ))}
            </tr>
          ))}
          <tr className="sect">
            <td colSpan={8}>Rostered against needed</td>
          </tr>
          {week.shifts.map((s) => (
            <tr key={`act-${s.shiftId}`}>
              <td>{s.name}</td>
              {s.days.map((d) => (
                <td key={d.date} className="num">
                  <Pill tone={d.status === 'pass' ? 'green' : d.status === 'short' ? 'red' : 'amber'}>
                    {d.actual}/{d.required} {d.status === 'pass' ? '✓' : d.status === 'short' ? 'short' : 'over'}
                  </Pill>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mute small" style={{ marginTop: 8 }}>
        D = day shift, N = night shift. • = changed for that day, ↻ = a weekly change. A grey cell means the guard works at another site that day.
        {manage ? ' Click any cell to change it.' : ''}
      </p>
    </div>
  );
}

function PatternStrip({ sequence, startDate, position, days = 14 }: { sequence: string[]; startDate: string; position: number; days?: number }) {
  return (
    <div className="strip" aria-label="The first two weeks">
      {Array.from({ length: days }, (_, i) => {
        const d = addDays(startDate, i);
        const s = patternSymbolOn(sequence, startDate, position, d);
        return (
          <span key={d} className={s === 'D' ? 'day' : s === 'N' ? 'night' : 'off'} title={dayLabel(d)}>
            <small>{dayLabel(d).split(' ')[0]}</small>
            {s === 'O' ? 'Off' : s}
          </span>
        );
      })}
    </div>
  );
}

function AllocatePanel({ siteId, siteName, from, onDone, onCancel }: { siteId: string; siteName: string; from: string; onDone: () => void; onCancel: () => void }) {
  const people = useLoad(() => api<Person[]>('/roster/people'));
  const patterns = useLoad(() => api<Pattern[]>('/roster/patterns'));
  const shifts = useLoad(() => api<ShiftOption[]>('/roster/shifts'));
  const dayShifts = shifts.data?.filter((s) => s.siteId === siteId && s.kind === 'day') ?? [];
  const nightShifts = shifts.data?.filter((s) => s.siteId === siteId && s.kind === 'night') ?? [];
  const [dayShiftId, setDayShiftId] = useState('');
  const [nightShiftId, setNightShiftId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [patternId, setPatternId] = useState('');
  const [startDate, setStartDate] = useState(from);
  const [position, setPosition] = useState(1);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [understood, setUnderstood] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const pattern = patterns.data?.find((p) => p.id === patternId);

  useEffect(() => {
    setWarnings([]);
    setUnderstood(false);
    if (!employeeId) return;
    api<{ warnings: string[] }>(`/roster/allocation-check?employeeId=${employeeId}&siteId=${siteId}`)
      .then((r) => setWarnings(r.warnings))
      .catch(setError);
  }, [employeeId, siteId]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api('/roster/allocations', {
        method: 'POST',
        json: {
          employeeId,
          siteId,
          patternId,
          startDate,
          position,
          dayShiftId: dayShiftId || null,
          nightShiftId: nightShiftId || null,
          reason: reason || undefined,
        },
      });
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const active = patterns.data?.filter((p) => p.active) ?? [];
  return (
    <div className="card panel">
      <h2>Allocate a guard to {siteName}</h2>
      <p className="mute small">Site + pattern + person. The position is where in the pattern this guard starts, so you choose whether he starts on a day or a night shift.</p>
      <ErrorBanner error={error ?? people.error ?? patterns.error} />
      <div className="grid g2">
        <Field label="Guard">
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">Choose a guard…</option>
            {people.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} (#{p.employeeNumber}, grade {p.grade}){p.allocatedSiteName ? ` · rostered at ${p.allocatedSiteName}` : ' · not rostered'}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Shift pattern" hint={active.length ? undefined : 'No patterns yet. Create one under Shift patterns first.'}>
          <select
            value={patternId}
            onChange={(e) => {
              setPatternId(e.target.value);
              setPosition(1);
            }}
          >
            <option value="">Choose a pattern…</option>
            {active.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.name} ({p.description})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Start date">
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </Field>
        <Field label="Position in the pattern" hint={pattern ? `Day ${position} of ${pattern.sequence.length}: ${pattern.sequence[position - 1] === 'D' ? 'a day shift' : pattern.sequence[position - 1] === 'N' ? 'a night shift' : 'a day off'}` : undefined}>
          <select value={position} onChange={(e) => setPosition(Number(e.target.value))} disabled={!pattern}>
            {(pattern?.sequence ?? ['D']).map((s, i) => (
              <option key={i} value={i + 1}>
                {i + 1} ({s === 'D' ? 'day' : s === 'N' ? 'night' : 'off'})
              </option>
            ))}
          </select>
        </Field>
        {dayShifts.length > 1 && (
          <Field label="On day-shift days, works">
            <select value={dayShiftId} onChange={(e) => setDayShiftId(e.target.value)}>
              {dayShifts.map((s, i) => (
                <option key={s.id} value={i === 0 ? '' : s.id}>
                  {s.name} {s.startTime}–{s.endTime}
                </option>
              ))}
            </select>
          </Field>
        )}
        {nightShifts.length > 1 && (
          <Field label="On night-shift days, works">
            <select value={nightShiftId} onChange={(e) => setNightShiftId(e.target.value)}>
              {nightShifts.map((s, i) => (
                <option key={s.id} value={i === 0 ? '' : s.id}>
                  {s.name} {s.startTime}–{s.endTime}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      {pattern && startDate && (
        <>
          <div className="small" style={{ fontWeight: 600, margin: '6px 0' }}>
            The first two weeks
          </div>
          <PatternStrip sequence={pattern.sequence} startDate={startDate} position={position} />
        </>
      )}
      {!!warnings.length && (
        <div className="banner warn" style={{ marginTop: 12 }}>
          <b>Please check before allocating:</b>
          <ul>
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <label className="row" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} /> I understand and want to go ahead
          </label>
          <Field label="Reason (recorded in the audit log)">
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: competency certificate on its way" />
          </Field>
        </div>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" disabled={busy || !employeeId || !patternId || !startDate || (warnings.length > 0 && !understood)} onClick={submit}>
          {busy ? 'Allocating…' : 'Allocate'}
        </button>
        <button className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ChangePanel({
  siteId,
  row,
  date: initialDate,
  cell,
  onDone,
  onCancel,
}: {
  siteId: string;
  row: Row | null;
  date: string;
  cell: Cell | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const shifts = useLoad(() => api<ShiftOption[]>('/roster/shifts'));
  const [date, setDate] = useState(initialDate);
  const people = useLoad(() => (row ? Promise.resolve(null) : api<Person[]>(`/roster/people?date=${date}`)), [date, !!row]);
  const [employeeId, setEmployeeId] = useState(row?.id ?? '');
  const [shiftId, setShiftId] = useState<string>(cell?.status === 'working' && cell.shiftId ? cell.shiftId : row ? 'off' : '');
  const [repeat, setRepeat] = useState(false);
  const [untilDate, setUntilDate] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const bySite = useMemo(() => {
    const m = new Map<string, ShiftOption[]>();
    for (const s of shifts.data ?? []) m.set(s.siteName, [...(m.get(s.siteName) ?? []), s]);
    return [...m.entries()];
  }, [shifts.data]);
  const who = row?.name ?? people.data?.find((p) => p.id === employeeId)?.name ?? 'the guard';
  const weekday = WEEKDAYS[weekdayIndex(date)];

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(() =>
      api('/roster/changes', {
        method: 'POST',
        json: {
          employeeId,
          shiftId: shiftId === 'off' ? null : shiftId,
          note,
          ...(repeat ? { weekday: weekdayIndex(date), fromDate: date, untilDate: untilDate || null } : { date }),
        },
      }),
    );

  return (
    <div className="card panel">
      <h2>{row ? `Change ${row.name} on ${dayLabel(date)}` : 'Add someone for one day'}</h2>
      {cell && (
        <p className="mute small">
          Now:{' '}
          {cell.status === 'working'
            ? `${cell.shiftName} ${cell.startTime}–${cell.endTime}${cell.elsewhere ? ` at ${cell.siteName}` : ''}`
            : cell.status === 'off'
              ? 'Off'
              : 'Not rostered'}
          {cell.source === 'change' ? ' (changed for this day)' : cell.source === 'weekly' ? ` (a weekly change, every ${weekday})` : cell.source === 'pattern' ? ' (from the pattern)' : ''}
        </p>
      )}
      <ErrorBanner error={error ?? shifts.error ?? people.error} />
      <div className="grid g2">
        {!row && (
          <>
            <Field label="Date">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Guard">
              <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                <option value="">Choose a guard…</option>
                {people.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} (#{p.employeeNumber}) ·{' '}
                    {p.on.status === 'working' ? `working ${p.on.shiftName} at ${p.on.siteName}` : p.on.status === 'off' ? `off at ${p.on.siteName}` : 'not rostered'} that day
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
        <Field label="Works">
          <select value={shiftId} onChange={(e) => setShiftId(e.target.value)}>
            {!row && <option value="">Choose a shift…</option>}
            {row && <option value="off">Day off</option>}
            {bySite.map(([site, list]) => (
              <optgroup key={site} label={site}>
                {list.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.kind === 'day' ? 'day' : 'night'}, {s.startTime}–{s.endTime}){s.siteId === siteId ? '' : ` at ${s.siteName}`}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>
        <Field label="How often">
          <select value={repeat ? 'weekly' : 'once'} onChange={(e) => setRepeat(e.target.value === 'weekly')}>
            <option value="once">Just this day</option>
            <option value="weekly">Every {weekday} from this date</option>
          </select>
        </Field>
        {repeat && (
          <Field label="Until (leave empty for no end)">
            <input type="date" value={untilDate} min={date} onChange={(e) => setUntilDate(e.target.value)} />
          </Field>
        )}
        <Field label="Note (optional)">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: relief for Site B, or family event" />
        </Field>
      </div>
      <p className="mute small">
        The pattern stays as it is; only {repeat ? `${weekday}s` : 'this day'} change{repeat ? '' : 's'} for {who}. A day shift straight after a night shift is never allowed.
      </p>
      <div className="row">
        <button className="btn" disabled={busy || !employeeId || !shiftId} onClick={save}>
          {busy ? 'Saving…' : 'Save change'}
        </button>
        {cell?.changeId && (
          <button className="btn ghost" disabled={busy} onClick={() => run(() => api(`/roster/changes/${cell.changeId}`, { method: 'DELETE' }))}>
            {cell.source === 'weekly' ? `Remove the weekly change (every ${weekday})` : 'Undo the change for this day'}
          </button>
        )}
        <button className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function RequirementPanel({ shift, date, onDone, onCancel }: { shift: ShiftReq; date: string; onDone: () => void; onCancel: () => void }) {
  const day = shift.days.find((d) => d.date === date)!;
  const [guards, setGuards] = useState(day.required);
  const [note, setNote] = useState(day.note);
  const [error, setError] = useState<unknown>(null);
  const send = async (value: number | null) => {
    setError(null);
    try {
      await api('/roster/requirements', { method: 'PUT', json: { shiftId: shift.shiftId, date, guards: value, note } });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e : new Error('Could not save.'));
    }
  };
  return (
    <div className="card panel">
      <h2>
        Guards needed: {shift.name} shift on {dayLabel(date)}
      </h2>
      <p className="mute small">For this one date only. The site&rsquo;s normal figures are set on the site page.</p>
      <ErrorBanner error={error} />
      <div className="row">
        <div className="stepper">
          <button type="button" aria-label="One fewer" disabled={guards <= 0} onClick={() => setGuards(guards - 1)}>
            −
          </button>
          <b>{guards}</b>
          <button type="button" aria-label="One more" onClick={() => setGuards(guards + 1)}>
            +
          </button>
        </div>
        <Field label="Reason (optional)">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: event night" />
        </Field>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn" onClick={() => send(guards)}>
          Save for this date
        </button>
        {day.changed && (
          <button className="btn ghost" onClick={() => send(null)}>
            Back to the normal number
          </button>
        )}
        <button className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
