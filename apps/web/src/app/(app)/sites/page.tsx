'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Pill, useLoad } from '@/components/ui';

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
  const { data, error } = useLoad(() => api<SiteRow[]>('/sites'));
  return (
    <>
      <div className="head">
        <div>
          <h1>Sites</h1>
          <p className="mute">Coverage compares officers assigned with the guards needed for one day.</p>
        </div>
        {can('sites.edit') && (
          <Link className="btn" href="/sites/new">
            + New site
          </Link>
        )}
      </div>
      <ErrorBanner error={error} />
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
