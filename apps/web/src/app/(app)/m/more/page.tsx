'use client';

import Link from 'next/link';
import { useSession } from '@/lib/session';

/** Supervisor app, More: the rest of the daily work, and the way back to the full website. */
export default function MobileMore() {
  const { me, can, signOut } = useSession();
  const items = [
    { href: '/m/reports', label: 'Reports', about: 'Open reports at your sites', show: can('reports.view') },
    { href: '/m/selfies', label: 'Selfie checks', about: 'Is it him in the Duty On selfie?', show: can('attendance.view') },
    { href: '/m/attendance', label: 'Attendance', about: 'Today’s register for your sites', show: can('attendance.view') },
    { href: '/alerts', label: 'All alerts sent to you', about: 'Including ones already dealt with', show: true },
    { href: '/account', label: 'My account', about: 'Alerts on this device, password', show: true },
    { href: '/', label: 'Full website', about: 'Roster, patrol setup, scores and everything else', show: true },
  ].filter((i) => i.show);
  return (
    <>
      <h1 className="m-h1">More</h1>
      <nav className="card m-menu" aria-label="More">
        {items.map((i) => (
          <Link key={i.href} href={i.href}>
            <span>
              <b>{i.label}</b>
              <span className="mute small">{i.about}</span>
            </span>
            <span className="go" aria-hidden="true">
              ›
            </span>
          </Link>
        ))}
      </nav>
      <p className="m-foot mute small">
        Signed in as {me.name}, {me.roleLabel.toLowerCase()}.
        <br />
        <button className="btn ghost" style={{ marginTop: 10, minHeight: 44 }} onClick={signOut}>
          Sign out
        </button>
      </p>
    </>
  );
}
