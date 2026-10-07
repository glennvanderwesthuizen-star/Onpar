'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Pill, useLoad } from '@/components/ui';

interface TestSite {
  siteId: string;
  name: string;
  gates: string[];
  password: string;
  tenants: { unit: string; name: string; email: string }[];
  announced: { unit: string; name: string; what: string; registration: string | null }[];
  staff: { unit: string; name: string; what: string; code: string; registration: string | null }[];
}

interface SiteRow {
  id: string;
  name: string;
  address: string;
  client: string;
  minimum_grade: string;
  armed: boolean;
  officers: number;
  guards_per_day: number;
}

export default function SitesPage() {
  const { can } = useSession();
  const router = useRouter();
  const { data, error, reload } = useLoad(() => api<SiteRow[]>('/sites'));
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<TestSite | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const makeTestSite = async () => {
    setBusy(true);
    setFailed(null);
    try {
      setMade(await api<TestSite>('/test-sites', { method: 'POST' }));
      setAsking(false);
      reload();
    } catch (e) {
      setFailed(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="head">
        <div>
          <h1>Sites</h1>
          <p className="mute">Coverage compares officers assigned with the guards needed for one day.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {can('customers.manage') && (
            <button className="btn ghost" onClick={() => setAsking(true)} disabled={busy}>
              + Test site
            </button>
          )}
          {can('sites.edit') && (
            <Link className="btn" href="/sites/new">
              + New site
            </Link>
          )}
        </div>
      </div>
      <ErrorBanner error={error} />
      <ErrorBanner error={failed} />
      {asking && (
        <div className="card">
          <h2>Make a test site?</h2>
          <p>
            This makes a made-up site for testing: two gates, twelve units with a tenant sign-in each, four announced visitors and two staff of a unit. No guards or phones are made;
            you move those there yourself. A test site cannot be deleted afterwards.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={makeTestSite} disabled={busy}>
              {busy ? 'Making…' : 'Make it'}
            </button>
            <button className="btn ghost" onClick={() => setAsking(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {made && (
        <div className="card">
          <h2>{made.name} is ready</h2>
          <p>
            <b>Keep this page open or copy it now.</b> The tenant password is shown only this once. (If you lose it, each tenant can be given a new one on the site page.)
          </p>
          <p>
            Gates: {made.gates.join(' and ')}. Tenant password, the same for all twelve: <b style={{ userSelect: 'all' }}>{made.password}</b>
          </p>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Unit</th>
                  <th>Tenant sign-in (email)</th>
                  <th>Already set up for this unit</th>
                </tr>
              </thead>
              <tbody>
                {made.tenants.map((t) => {
                  const a = made.announced.filter((x) => x.unit === t.unit).map((x) => `${x.name}${x.registration ? ` (${x.registration})` : ''}: ${x.what}`);
                  const st = made.staff.filter((x) => x.unit === t.unit).map((x) => `${x.name}: ${x.what}${x.registration ? ` (${x.registration})` : ''}, gate code ${x.code}`);
                  return (
                    <tr key={t.unit}>
                      <td>{t.unit}</td>
                      <td style={{ userSelect: 'all' }}>{t.email}</td>
                      <td>{[...a, ...st].join('; ') || <span className="mute">Nothing: use for unannounced visitors</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <Link className="btn" href={`/sites/${made.siteId}`}>
              Open {made.name}
            </Link>
            <button className="btn ghost" onClick={() => setMade(null)}>
              I have copied it
            </button>
          </div>
        </div>
      )}
      <div className="card scroll">
        {data && !data.length && <p className="mute">No sites yet. Create the first one to start enrolling officers.</p>}
        {!!data?.length && (
          <table>
            <thead>
              <tr>
                <th>Site</th>
                <th>Client</th>
                <th>Min. grade</th>
                <th>Armed</th>
                <th>Coverage</th>
              </tr>
            </thead>
            <tbody>
              {data.map((s) => (
                <tr key={s.id} className="link" onClick={() => router.push(`/sites/${s.id}`)}>
                  <td>
                    <Link href={`/sites/${s.id}`}>
                      <b>{s.name}</b>
                    </Link>
                    <div className="mute small">{s.address}</div>
                  </td>
                  <td>{s.client}</td>
                  <td>Grade {s.minimum_grade}</td>
                  <td>{s.armed ? <Pill tone="red">Armed</Pill> : <Pill tone="grey">Unarmed</Pill>}</td>
                  <td>
                    <Pill tone={s.officers >= s.guards_per_day ? 'green' : 'amber'}>
                      {s.officers} of {s.guards_per_day}
                    </Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
