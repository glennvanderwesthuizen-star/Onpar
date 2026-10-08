'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { ErrorBanner, Field, Pill, formatDateTime, useLoad } from '@/components/ui';

interface SiteRow {
  siteId: string;
  site: string;
  onSite: number;
  overstays: number;
  needAction: number;
  expected: number;
  openExceptions: number;
  today: { visits: number; letIn: number; turnedAway: number; waiting: number; noSignal: number };
  rollCall: { id: string; startedAt: string } | null;
}
interface Dashboard {
  sites: SiteRow[];
  totals: { onSite: number; overstays: number; needAction: number; expected: number; openExceptions: number; visits: number };
}
interface ReportRow {
  key: string;
  label: string;
  visits: number;
  letIn: number;
  turnedAway: number;
  expected: number;
  noSignal: number;
  passengers: number;
  exceptions: number;
}
interface Report {
  from: string;
  to: string;
  by: string;
  rows: ReportRow[];
  total: Omit<ReportRow, 'key' | 'label'>;
}

const BY = [
  ['day', 'Day'],
  ['site', 'Site'],
  ['gate', 'Gate'],
  ['unit', 'Unit'],
  ['category', 'Kind of visitor'],
  ['guard', 'Guard'],
  ['status', 'Outcome'],
] as const;

/**
 * Visitors across the sites (visitor specification, portal; owner's step 5): who is on site now,
 * who is expected, open exceptions and overstays, and reports for any period.
 */
export default function VisitorsPage() {
  const { data, error } = useLoad(() => api<Dashboard>('/visitors/dashboard'));
  return (
    <>
      <h1>Visitors</h1>
      <ErrorBanner error={error} />
      {data && <Overview data={data} />}
      {data && <Reports sites={data.sites} />}
    </>
  );
}

function Overview({ data }: { data: Dashboard }) {
  const t = data.totals;
  return (
    <div className="card scroll">
      <h2>Now</h2>
      <p className="mute small">
        {t.onSite} on site across the gates{t.overstays ? `, ${t.overstays} past their time` : ''}
        {t.needAction ? ` (${t.needAction} not yet dealt with by the guard)` : ''}. {t.expected} expected today. {t.openExceptions} exceptions to look into. {t.visits} visits today.
      </p>
      {!data.sites.length && <p className="mute">No site has a gate yet. Add one on the site&apos;s page.</p>}
      {!!data.sites.length && (
        <table>
          <thead>
            <tr>
              <th>Site</th>
              <th>On site</th>
              <th>Past their time</th>
              <th>Expected today</th>
              <th>Exceptions open</th>
              <th>Today: let in</th>
              <th>Turned away</th>
              <th>Waiting</th>
              <th>No signal</th>
            </tr>
          </thead>
          <tbody>
            {data.sites.map((s) => (
              <tr key={s.siteId}>
                <td>
                  <Link href={`/sites/${s.siteId}`}>{s.site}</Link>
                  {s.rollCall && (
                    <div>
                      <Link href={`/sites/${s.siteId}/roll-call`}>
                        <Pill tone="red">Roll-call since {formatDateTime(s.rollCall.startedAt)}</Pill>
                      </Link>
                    </div>
                  )}
                </td>
                <td>{s.onSite}</td>
                <td>{s.overstays ? <Pill tone={s.needAction ? 'red' : 'amber'}>{s.overstays}</Pill> : 0}</td>
                <td>{s.expected}</td>
                <td>{s.openExceptions ? <Pill tone="amber">{s.openExceptions}</Pill> : 0}</td>
                <td>{s.today.letIn}</td>
                <td>{s.today.turnedAway}</td>
                <td>{s.today.waiting}</td>
                <td>{s.today.noSignal}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mute small" style={{ marginTop: 8 }}>
        Emergency roll-call: open the site and press <b>Start a roll-call</b>, or go straight to it from the site&apos;s name above.
      </p>
    </div>
  );
}

const day = (offset: number) => new Date(Date.now() + 2 * 3600_000 + offset * 86_400_000).toISOString().slice(0, 10);

function Reports({ sites }: { sites: SiteRow[] }) {
  const [from, setFrom] = useState(day(-6));
  const [to, setTo] = useState(day(0));
  const [siteId, setSiteId] = useState('');
  const [by, setBy] = useState('day');
  const query = new URLSearchParams({ from, to, by, ...(siteId ? { siteId } : {}) }).toString();
  const { data, error } = useLoad(() => api<Report>(`/visitors/report?${query}`), [query]);
  const fileQuery = new URLSearchParams({ from, to, ...(siteId ? { siteId } : {}) }).toString();
  return (
    <div className="card scroll">
      <h2>Reports</h2>
      <div className="grid g4">
        <Field label="From">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Site">
          <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
            <option value="">All sites</option>
            {sites.map((s) => (
              <option key={s.siteId} value={s.siteId}>
                {s.site}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Count by">
          <select value={by} onChange={(e) => setBy(e.target.value)}>
            {BY.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <ErrorBanner error={error} />
      {data && (
        <table>
          <thead>
            <tr>
              <th>{BY.find(([v]) => v === data.by)?.[1]}</th>
              <th>Visits</th>
              <th>Let in</th>
              <th>Turned away</th>
              <th>Expected</th>
              <th>Passengers</th>
              <th>With an exception</th>
              <th>No signal</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.key}>
                <td>{r.label}</td>
                <td>{r.visits}</td>
                <td>{r.letIn}</td>
                <td>{r.turnedAway}</td>
                <td>{r.expected}</td>
                <td>{r.passengers}</td>
                <td>{r.exceptions}</td>
                <td>{r.noSignal}</td>
              </tr>
            ))}
            {!data.rows.length && (
              <tr>
                <td colSpan={8} className="mute">
                  No visits in this period.
                </td>
              </tr>
            )}
            {data.rows.length > 1 && (
              <tr>
                <td>
                  <b>Total</b>
                </td>
                <td>
                  <b>{data.total.visits}</b>
                </td>
                <td>{data.total.letIn}</td>
                <td>{data.total.turnedAway}</td>
                <td>{data.total.expected}</td>
                <td>{data.total.passengers}</td>
                <td>{data.total.exceptions}</td>
                <td>{data.total.noSignal}</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <a className="btn ghost sm" href={`/api/visitors/report.csv?${fileQuery}`}>
          Download every visit in this period (spreadsheet)
        </a>
        <span className="mute small">ID numbers show their last four characters only. Each download is recorded.</span>
      </div>
    </div>
  );
}
