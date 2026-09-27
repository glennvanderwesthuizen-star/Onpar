'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { SiteForm, SiteValue } from '@/components/SiteForm';
import { ErrorBanner, Pill, useLoad } from '@/components/ui';

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
          This is a simple count for one day. Real rosters need relief guards, which the rostering milestone will handle.
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
    </>
  );
}

function ReadOnlySite({ site }: { site: Site }) {
  return (
    <>
      <div className="card">
        <p>
          Minimum grade {site.minimumGrade} · {site.armed ? 'Armed' : 'Unarmed'} · Payroll month starts on day{' '}
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
