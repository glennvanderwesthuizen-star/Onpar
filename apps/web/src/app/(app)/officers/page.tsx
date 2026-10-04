'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { qualificationStatus } from '@onpar/rules';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, Pill, StatusPill, formatDate, useLoad } from '@/components/ui';
import { TsfPlate } from '@/components/TsfPlate';

interface OfficerRow {
  id: string;
  employee_number: string;
  tsf_number: string | null;
  full_name: string;
  id_number_masked: string;
  psira_grade: string;
  psira_expiry: string;
  status: string;
  locked: boolean;
  site_name: string;
}

export default function OfficersPage() {
  const { can } = useSession();
  const router = useRouter();
  const { data, error } = useLoad(() => api<OfficerRow[]>('/officers'));
  const today = new Date();
  return (
    <>
      <div className="head">
        <div>
          <h1>Officers</h1>
          <p className="mute">Everyone enrolled at the sites you can see.</p>
        </div>
        <div className="row">
          <Link className="btn ghost" href="/officers/cards">
            Print ID cards
          </Link>
          {can('officers.enrol') && (
            <Link className="btn" href="/officers/new">
              + Enrol officer
            </Link>
          )}
        </div>
      </div>
      <ErrorBanner error={error} />
      <div className="card scroll">
        {data && !data.length && <p className="mute">No officers enrolled yet.</p>}
        {!!data?.length && (
          <table>
            <thead>
              <tr>
                <th>Officer</th>
                <th>TSF number</th>
                <th>Site</th>
                <th>PSIRA</th>
                <th>PSIRA expiry</th>
                <th>Account</th>
              </tr>
            </thead>
            <tbody>
              {data.map((o) => (
                <tr key={o.id} className="link" onClick={() => router.push(`/officers/${o.id}`)}>
                  <td>
                    <Link href={`/officers/${o.id}`}>
                      <b>{o.full_name}</b>
                    </Link>
                    <div className="mute small">
                      #{o.employee_number} · ID {o.id_number_masked}
                    </div>
                  </td>
                  <td>
                    <TsfPlate number={o.tsf_number} size="sm" />
                  </td>
                  <td>{o.site_name}</td>
                  <td>Grade {o.psira_grade}</td>
                  <td>
                    {formatDate(o.psira_expiry)} <StatusPill status={qualificationStatus(o.psira_expiry, today)} />
                  </td>
                  <td>{o.locked ? <Pill tone="red">Locked (PIN)</Pill> : <Pill tone="green">Active</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
