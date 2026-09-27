'use client';

import Link from 'next/link';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, useLoad } from '@/components/ui';

interface Counts {
  sites: number;
  officers: number;
  locked: number;
  devices: number;
  devicesOffline: number;
}

export default function Overview() {
  const { me, can } = useSession();
  const { data, error } = useLoad<Counts>(async () => {
    const [sites, officers, devices] = await Promise.all([
      can('sites.view') ? api<unknown[]>('/sites') : [],
      can('officers.view') ? api<{ locked: boolean }[]>('/officers') : [],
      can('devices.view') ? api<{ lastSeenAt: string | null; status: string }[]>('/devices') : [],
    ]);
    const hourAgo = Date.now() - 60 * 60 * 1000;
    return {
      sites: sites.length,
      officers: officers.length,
      locked: officers.filter((o) => o.locked).length,
      devices: devices.filter((d) => d.status !== 'retired').length,
      devicesOffline: devices.filter(
        (d) => d.status === 'active' && (!d.lastSeenAt || new Date(d.lastSeenAt).getTime() < hourAgo),
      ).length,
    };
  });

  return (
    <>
      <div className="head">
        <div>
          <h1>Good day, {me.name.split(' ')[0]}</h1>
          <p className="mute">{me.company.name}</p>
        </div>
      </div>
      <ErrorBanner error={error} />
      <div className="tiles">
        <Link className="tile" href="/sites">
          <b>{data?.sites ?? '–'}</b>
          <span>Sites</span>
        </Link>
        <Link className="tile" href="/officers">
          <b>{data?.officers ?? '–'}</b>
          <span>Officers enrolled</span>
        </Link>
        <Link className="tile" href="/officers">
          <b style={{ color: data?.locked ? 'var(--red)' : undefined }}>{data?.locked ?? '–'}</b>
          <span>Locked out (PIN)</span>
        </Link>
        <Link className="tile" href="/devices">
          <b>{data?.devices ?? '–'}</b>
          <span>Post devices</span>
        </Link>
        <Link className="tile" href="/devices">
          <b style={{ color: data?.devicesOffline ? 'var(--amber)' : undefined }}>{data?.devicesOffline ?? '–'}</b>
          <span>Devices not seen in the last hour</span>
        </Link>
      </div>
      <div className="card">
        <h2>What is here so far</h2>
        <p className="mute">
          This is Milestone 1, the foundation: sites, officer enrolment, post devices, sign-in and the audit log. Attendance,
          tasks, patrols, reports and scores arrive in the next milestones and will appear on this page as they are built.
        </p>
      </div>
    </>
  );
}
