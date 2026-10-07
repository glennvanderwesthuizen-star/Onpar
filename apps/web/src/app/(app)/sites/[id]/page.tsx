'use client';

import { provinceName } from '@onpar/rules';
import Link from 'next/link';
import { use, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { SiteForm, SiteValue } from '@/components/SiteForm';
import { ErrorBanner, Pill, useLoad } from '@/components/ui';
import { SiteCustomers } from '@/components/SiteCustomers';
import { SiteVisitExceptions, SiteVisitors, SiteVisits } from '@/components/SiteVisitors';

type Site = SiteValue & { id: string; coverage: { officers: number; neededPerDay: number } };

export default function SitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { can } = useSession();
  const { data, error } = useLoad(() => api<Site>(`/sites/${id}`), [id]);
  const [coverage, setCoverage] = useState<Site['coverage'] | null>(null);

  if (error) return <ErrorBanner error={error} />;
  if (!data) return <p className="mute">Loading…</p>;
  const cov = coverage ?? data.coverage;

  return (
    <>
      <div className="head">
        <div>
          <Link href="/sites" className="mute small">
            ← Sites
          </Link>
          <h1>{data.name}</h1>
          <p className="mute">
            {data.client} · {data.address}
          </p>
        </div>
        <div className="row">
          <Pill tone={cov.officers >= cov.neededPerDay ? 'green' : 'amber'}>
            Coverage: {cov.officers} officers for {cov.neededPerDay} guards per day
          </Pill>
        </div>
      </div>
      {cov.officers < cov.neededPerDay && (
        <div className="banner warn">
          This is a simple count for one day. Real rosters need relief guards; see this site on the{' '}
          <Link href={`/roster?site=${id}`}>Roster</Link> page for who works which day.
        </div>
      )}
      {can('sites.edit') ? (
        <SiteForm
          autosave
          initial={data}
          onSave={async (v) => {
            const saved = await api<Site>(`/sites/${id}`, { method: 'PUT', json: v });
            setCoverage(saved.coverage);
            return saved;
          }}
        />
      ) : (
        <ReadOnlySite site={data} />
      )}
      <SiteCustomers siteId={id} />
      <SiteVisitExceptions siteId={id} />
      <SiteVisits siteId={id} />
      <SiteVisitors siteId={id} />
    </>
  );
}

function ReadOnlySite({ site }: { site: Site }) {
  return (
    <>
      <div className="card">
        <p>
          {site.province ? `${provinceName(site.province)} · ` : 'Province not set · '}Minimum grade {site.minimumGrade} · {site.armed ? 'Armed' : 'Unarmed'} · Payroll month starts on day{' '}
          {site.payrollStartDay}
        </p>
      </div>
      <div className="grid g2">
        {site.shifts.map((s) => (
          <div key={s.id} className={`shift ${s.kind}`}>
            <span className="badge">{s.kind === 'day' ? 'DAY SHIFT' : 'NIGHT SHIFT'}</span>
            <h3>{s.name}</h3>
            <p>
              {s.startTime} to {s.endTime} · {s.guardsRequired} guards
            </p>
          </div>
        ))}
      </div>
    </>
  );
}
