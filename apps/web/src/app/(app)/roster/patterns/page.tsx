'use client';

import Link from 'next/link';
import { useState } from 'react';
import { describePattern, patternErrors, sastDate } from '@onpar/rules';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Field, Pill, formatDate, useLoad } from '@/components/ui';

interface Pattern {
  id: string;
  code: string;
  name: string;
  sequence: string[];
  description: string;
  active: boolean;
  inUse: number;
}

const WORD: Record<string, string> = { D: 'Day', N: 'Night', O: 'Off' };

/** Tap Day, Night or Off to build the cycle; the Night-into-Day check runs as you go. */
function Builder({ initial, onSave, onCancel, saveLabel }: { initial?: Pattern; onSave: (name: string, seq: string[], active: boolean) => Promise<void>; onCancel?: () => void; saveLabel: string }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [seq, setSeq] = useState<string[]>(initial?.sequence ?? []);
  const [active, setActive] = useState(initial?.active ?? true);
  const [error, setError] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const errors = patternErrors({ name, sequence: seq });
  const show = touched || seq.length > 0;

  async function save() {
    setTouched(true);
    if (Object.keys(errors).length) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(name, seq, active);
      if (!initial) {
        setName('');
        setSeq([]);
        setTouched(false);
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <ErrorBanner error={error} />
      <Field label="Pattern name" error={touched ? errors.name : undefined} hint="For example: 3 day / 3 night / 3 off">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <div className="small" style={{ fontWeight: 600, margin: '8px 0 6px' }}>
        The cycle, day by day {seq.length ? `(${seq.length} days: ${describePattern(seq)})` : ''}
      </div>
      <div className="strip big">
        {seq.map((s, i) => (
          <button
            key={i}
            type="button"
            className={s === 'D' ? 'day' : s === 'N' ? 'night' : 'off'}
            title="Click to change: Day, Night, Off"
            onClick={() => setSeq(seq.map((x, j) => (j === i ? (x === 'D' ? 'N' : x === 'N' ? 'O' : 'D') : x)))}
          >
            <small>{i + 1}</small>
            {WORD[s]}
          </button>
        ))}
        {!seq.length && <span className="mute small">Add days below.</span>}
      </div>
      <div className="row" style={{ margin: '8px 0' }}>
        <button type="button" className="btn ghost sm" onClick={() => setSeq([...seq, 'D'])}>
          + Day
        </button>
        <button type="button" className="btn ghost sm" onClick={() => setSeq([...seq, 'N'])}>
          + Night
        </button>
        <button type="button" className="btn ghost sm" onClick={() => setSeq([...seq, 'O'])}>
          + Off
        </button>
        <button type="button" className="btn ghost sm" disabled={!seq.length} onClick={() => setSeq(seq.slice(0, -1))}>
          Remove last
        </button>
      </div>
      {show && errors.sequence && <div className="err">{errors.sequence}</div>}
      {show && !errors.sequence && seq.length > 0 && <div className="mute small">No night shift is followed straight by a day shift, including when the cycle starts again.</div>}
      {initial && (
        <label className="row small" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> In use for new allocations
        </label>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : saveLabel}
        </button>
        {onCancel && (
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

export default function PatternsPage() {
  const { can } = useSession();
  const patterns = useLoad(() => api<Pattern[]>('/roster/patterns'));
  const [editing, setEditing] = useState<string | null>(null);
  const edit = can('roster.patterns');

  return (
    <>
      <div className="head">
        <div>
          <Link href="/roster" className="mute small">
            ← Roster
          </Link>
          <h1>Shift patterns</h1>
          <p className="mute">
            A pattern is a repeating cycle of day, night and off days. It works at every site: D means the site&rsquo;s day shift and N its night shift.
          </p>
        </div>
      </div>
      <ErrorBanner error={patterns.error} />
      <div className="card scroll">
        {patterns.data && !patterns.data.length && <p className="mute">No patterns yet.{edit ? ' Create the first one below.' : ''}</p>}
        {!!patterns.data?.length && (
          <table>
            <thead>
              <tr>
                <th>No.</th>
                <th>Pattern</th>
                <th>Cycle</th>
                <th>Guards on it</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {patterns.data.map((p) =>
                editing === p.id ? (
                  <tr key={p.id}>
                    <td colSpan={5}>
                      <Builder
                        initial={p}
                        saveLabel="Save pattern"
                        onCancel={() => setEditing(null)}
                        onSave={async (name, sequence, active) => {
                          await api(`/roster/patterns/${p.id}`, { method: 'PUT', json: { name, sequence: sequence.join(''), active } });
                          setEditing(null);
                          patterns.reload();
                        }}
                      />
                      {p.inUse > 0 && <p className="mute small">Changing the cycle changes the shifts of the {p.inUse} guard(s) on this pattern from now on.</p>}
                    </td>
                  </tr>
                ) : (
                  <tr key={p.id}>
                    <td>
                      <b>{p.code}</b>
                    </td>
                    <td>
                      {p.name} {!p.active && <Pill tone="grey">Not in use</Pill>}
                      <div className="mute small">{p.description}</div>
                    </td>
                    <td>
                      <div className="strip">
                        {p.sequence.map((s, i) => (
                          <span key={i} className={s === 'D' ? 'day' : s === 'N' ? 'night' : 'off'}>
                            {s === 'O' ? 'Off' : s}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>{p.inUse}</td>
                    <td>
                      {edit && (
                        <button className="btn ghost sm" onClick={() => setEditing(p.id)}>
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
      </div>
      {edit && (
        <div className="card">
          <h2>New pattern</h2>
          <Builder
            saveLabel="Create pattern"
            onSave={async (name, sequence) => {
              await api('/roster/patterns', { method: 'POST', json: { name, sequence: sequence.join('') } });
              patterns.reload();
            }}
          />
        </div>
      )}
      <Holidays edit={edit} />
    </>
  );
}

function Holidays({ edit }: { edit: boolean }) {
  const [year, setYear] = useState(Number(sastDate(new Date()).slice(0, 4)));
  const data = useLoad(() => api<{ statutory: string[]; added: { date: string; name: string }[] }>(`/roster/holidays?year=${year}`), [year]);
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);

  async function add() {
    setError(null);
    try {
      await api('/roster/holidays', { method: 'POST', json: { date, name } });
      setDate('');
      setName('');
      data.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e : new Error('Could not add the holiday.'));
    }
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Public holidays {year}</h2>
        <div className="row">
          <button className="btn ghost sm" onClick={() => setYear(year - 1)}>
            ← {year - 1}
          </button>
          <button className="btn ghost sm" onClick={() => setYear(year + 1)}>
            {year + 1} →
          </button>
        </div>
      </div>
      <p className="mute small">
        Sites can need a different number of guards on public holidays. South Africa&rsquo;s public holidays, including the Monday after one that falls on a Sunday, are
        worked out automatically. Add any extra day the President declares, such as an election day.
      </p>
      <ErrorBanner error={error ?? data.error} />
      <div className="grid g2">
        <div>
          {data.data?.statutory.map((d) => (
            <div key={d} className="line">
              <span>{formatDate(d)}</span>
            </div>
          ))}
        </div>
        <div>
          <h3>Added by your company</h3>
          {data.data && !data.data.added.length && <p className="mute small">None.</p>}
          {data.data?.added.map((h) => (
            <div key={h.date} className="line">
              <span>
                {formatDate(h.date)} · {h.name}
              </span>
              {edit && (
                <button
                  className="btn ghost sm"
                  onClick={async () => {
                    await api(`/roster/holidays/${h.date}`, { method: 'DELETE' });
                    data.reload();
                  }}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
          {edit && (
            <div className="row" style={{ marginTop: 10, alignItems: 'flex-end' }}>
              <Field label="Date">
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
              <Field label="Name">
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Election day" />
              </Field>
              <button className="btn" disabled={!date || !name.trim()} onClick={add}>
                Add
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
