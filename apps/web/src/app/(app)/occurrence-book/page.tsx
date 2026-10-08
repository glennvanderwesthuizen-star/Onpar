'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { EOB_CATEGORIES, EOB_CATEGORY_LABELS, EobCategory } from '@onpar/rules';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { AuthPhoto } from '@/components/AuthPhoto';
import { ErrorBanner, Field, useLoad } from '@/components/ui';

interface Entry {
  key: string;
  at: string;
  category: EobCategory;
  categoryLabel: string;
  alert: 'green' | 'amber' | 'red' | null;
  colour: string | null;
  reportNumber: number | null;
  photo: string | null;
  text: string;
  by: string;
  lateSynced: boolean;
}
interface Book {
  site: string;
  date: string;
  banner: string;
  entries: Entry[];
  counts: Partial<Record<EobCategory, number>>;
}

const today = () => new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Johannesburg' });
const LIGHT = { green: '#1f9d55', amber: '#d68a00', red: '#c62828' };

/** Priority as a small flat traffic light: only the true colour lit (brief section 24). */
function TrafficLight({ alert }: { alert: Entry['alert'] }) {
  if (!alert) return null;
  return (
    <span title={`${alert[0].toUpperCase()}${alert.slice(1)} priority`} style={{ display: 'inline-flex', gap: 3 }}>
      {(['green', 'amber', 'red'] as const).map((c) => (
        <span key={c} style={{ width: 9, height: 9, borderRadius: 9, background: c === alert ? LIGHT[c] : '#d5d9de' }} />
      ))}
    </span>
  );
}

/**
 * The Electronic Occurrence Book (brief section 27): one site, one day, in time order, put
 * together from everything On Par already records. Not the official OB.
 */
export default function OccurrenceBookPage() {
  return (
    <Suspense fallback={<p className="mute">Loading…</p>}>
      <OccurrenceBook />
    </Suspense>
  );
}

function OccurrenceBook() {
  const { can } = useSession();
  const params = useSearchParams();
  const sites = useLoad(() => api<{ id: string; name: string }[]>('/sites'));
  const [siteId, setSiteId] = useState(params.get('site') ?? '');
  const [date, setDate] = useState(params.get('date') ?? today());
  const [only, setOnly] = useState<EobCategory | ''>('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!siteId && sites.data?.length) setSiteId(sites.data[0].id);
  }, [sites.data, siteId]);
  const { data, error, reload } = useLoad(() => (siteId ? api<Book>(`/sites/${siteId}/occurrence-book?date=${date}`) : Promise.resolve(null)), [siteId, date]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.entries ?? []).filter((e) => (!only || e.category === only) && (!q || `${e.text} ${e.by} ${e.reportNumber ?? ''}`.toLowerCase().includes(q)));
  }, [data, only, search]);

  return (
    <>
      <h1>Occurrence Book</h1>
      <div className="banner warn" style={{ fontWeight: 600 }}>
        {data?.banner ?? 'This is not the official Occurrence Book. It does not replace the site’s paper or electronic OB, which continues as normal.'}
      </div>
      <div className="card no-print">
        <div className="grid g4">
          <Field label="Site">
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              {(sites.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Day">
            <input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value || today())} />
          </Field>
          <Field label="Show">
            <select value={only} onChange={(e) => setOnly(e.target.value as EobCategory | '')}>
              <option value="">Everything</option>
              {EOB_CATEGORIES.filter((c) => data?.counts[c]).map((c) => (
                <option key={c} value={c}>
                  {EOB_CATEGORY_LABELS[c]} ({data?.counts[c]})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Search">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, report number, words" />
          </Field>
        </div>
        <div className="row small">
          <button className="btn ghost sm" onClick={() => setDate(new Date(Date.parse(`${date}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10))}>
            ← Day before
          </button>
          {date < today() && (
            <button className="btn ghost sm" onClick={() => setDate(new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10))}>
              Day after →
            </button>
          )}
          <button className="btn ghost sm" onClick={() => window.print()}>
            Print
          </button>
          <span className="mute">On a phone, turn it sideways for the full width.</span>
        </div>
      </div>
      <ErrorBanner error={error ?? sites.error} />
      {data && (
        <div className="card scroll">
          <h2>
            {data.site}, {new Date(`${data.date}T12:00:00Z`).toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
          </h2>
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Category</th>
                <th>Alert</th>
                <th>Photo</th>
                <th>Entry</th>
                <th>Recorded by</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => (
                <tr key={e.key}>
                  <td style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{time(e.at)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {e.reportNumber !== null ? (
                      <span className="pill" style={{ background: e.colour ?? '#555', color: '#fff' }}>
                        #{e.reportNumber}
                      </span>
                    ) : (
                      e.categoryLabel
                    )}
                  </td>
                  <td>
                    <TrafficLight alert={e.alert} />
                  </td>
                  <td>
                    {e.photo &&
                      (open === e.key ? (
                        <AuthPhoto path={`/sites/${siteId}/occurrence-book/photo/${e.photo}`} alt={`Photo: ${e.text}`} width={160} />
                      ) : (
                        <button className="btn ghost sm" title="Show the photo" onClick={() => setOpen(e.key)}>
                          📷
                        </button>
                      ))}
                  </td>
                  <td>
                    {e.text}
                    {e.lateSynced && <div className="mute small">Sent later: the phone had no signal</div>}
                  </td>
                  <td>{e.by}</td>
                </tr>
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={6} className="mute">
                    {data.entries.length ? 'Nothing matches.' : 'Nothing was recorded at this site on this day.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {data && can('eob.write') && <WriteEntry siteId={siteId} entries={data.entries} done={reload} />}
    </>
  );
}

/** Something On Par did not record by itself. A written entry is never changed: a correction is a new entry. */
function WriteEntry({ siteId, entries, done }: { siteId: string; entries: Entry[]; done: () => void }) {
  const [text, setText] = useState('');
  const [at, setAt] = useState('');
  const [corrects, setCorrects] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const written = entries.filter((e) => e.category === 'entry');
  async function save(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api(`/sites/${siteId}/occurrence-book`, {
        method: 'POST',
        json: { text, at: at ? new Date(`${at}:00+02:00`).toISOString() : null, corrects: corrects || null },
      });
      setText('');
      setAt('');
      setCorrects('');
      done();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card no-print" onSubmit={save}>
      <h2>Write an entry</h2>
      <p className="mute small">For anything On Par did not record by itself. An entry cannot be changed afterwards; to correct one, write a correction.</p>
      <ErrorBanner error={err} />
      <Field label="What happened">
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} />
      </Field>
      <div className="grid g2">
        <Field label="When it happened (leave empty for now)">
          <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        </Field>
        {!!written.length && (
          <Field label="This corrects (optional)">
            <select value={corrects} onChange={(e) => setCorrects(e.target.value)}>
              <option value="">Nothing: a new entry</option>
              {written.map((e) => (
                <option key={e.key} value={e.key.replace('entry:', '')}>
                  {time(e.at)} {e.text.slice(0, 60)}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <button className="btn" disabled={busy || text.trim().length < 3}>
        {busy ? 'Saving…' : 'Write it in the book'}
      </button>
    </form>
  );
}
