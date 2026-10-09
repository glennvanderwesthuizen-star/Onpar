'use client';

import { useState } from 'react';
import { EOB_CATEGORIES, EOB_CATEGORY_LABELS, EobCategory } from '@onpar/rules';
import { api } from '@/lib/api';
import { ErrorBanner, useLoad } from '@/components/ui';

interface Entry {
  key: string;
  at: string;
  category: EobCategory;
  categoryLabel: string;
  alert: 'green' | 'amber' | 'red' | null;
  colour: string | null;
  reportNumber: number | null;
  text: string;
  by: string;
}
interface Book {
  site: string;
  date: string;
  banner: string;
  entries: Entry[];
  counts: Partial<Record<EobCategory, number>>;
}

const today = () => new Date(Date.now() + 2 * 3600_000).toISOString().slice(0, 10);
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Johannesburg' });
const LIGHT = { green: '#1f9d55', amber: '#d68a00', red: '#c62828' };

/** The site's Occurrence Book for the client (owner, 9 Oct 2026, D-51): read only, one day at a time. */
export default function ClientBook() {
  const [date, setDate] = useState(today());
  const [only, setOnly] = useState<EobCategory | ''>('');
  const { data, error } = useLoad(() => api<Book>(`/customer/occurrence-book?date=${date}`), [date]);
  const shown = (data?.entries ?? []).filter((e) => !only || e.category === only);
  return (
    <>
      <h1>Occurrence Book</h1>
      <div className="banner warn small">{data?.banner ?? 'This is not the official Occurrence Book.'}</div>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn ghost sm" onClick={() => setDate(shift(date, -1))}>
          ←
        </button>
        <input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value || today())} style={{ maxWidth: 170 }} />
        {date < today() && (
          <button className="btn ghost sm" onClick={() => setDate(shift(date, 1))}>
            →
          </button>
        )}
        <select value={only} onChange={(e) => setOnly(e.target.value as EobCategory | '')} style={{ maxWidth: 160 }}>
          <option value="">Everything</option>
          {EOB_CATEGORIES.filter((c) => data?.counts[c]).map((c) => (
            <option key={c} value={c}>
              {EOB_CATEGORY_LABELS[c]} ({data?.counts[c]})
            </option>
          ))}
        </select>
      </div>
      <ErrorBanner error={error} />
      {data && !shown.length && <p className="mute">Nothing recorded on this day.</p>}
      {shown.map((e) => (
        <div key={e.key} className="card" style={{ padding: 10, marginBottom: 6 }}>
          <div className="row small" style={{ justifyContent: 'space-between' }}>
            <b style={{ fontVariantNumeric: 'tabular-nums' }}>{time(e.at)}</b>
            <span>
              {e.reportNumber !== null ? (
                <span className="pill" style={{ background: e.colour ?? '#555', color: '#fff' }}>
                  #{e.reportNumber}
                </span>
              ) : (
                <span className="mute">{e.categoryLabel}</span>
              )}
              {e.alert && <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 9, marginLeft: 6, background: LIGHT[e.alert] }} />}
            </span>
          </div>
          <div>{e.text}</div>
          <div className="mute small">{e.by}</div>
        </div>
      ))}
    </>
  );
}
