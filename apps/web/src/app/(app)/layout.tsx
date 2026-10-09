'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SessionProvider, useSession } from '@/lib/session';
import { ChangePassword } from '@/components/ChangePassword';
import { PanicBanner } from '@/components/PanicBanner';
import { BoloBanner } from '@/components/BoloBanner';
import { AlertsLink } from '@/components/AlertsLink';
import { MobileShell } from '@/components/MobileShell';

const NAV = [
  { href: '/', label: 'Overview', permission: null },
  { href: '/panic', label: 'Panic', permission: 'panic.view' },
  { href: '/roster', label: 'Roster', permission: 'roster.view' },
  { href: '/attendance', label: 'Attendance', permission: 'attendance.view' },
  { href: '/register', label: 'Register', permission: 'register.view' },
  { href: '/tasks', label: 'Tasks', permission: 'tasks.view' },
  { href: '/patrols', label: 'Patrols', permission: 'patrols.view' },
  { href: '/reports', label: 'Reports', permission: 'reports.view' },
  { href: '/visitors', label: 'Visitors', permission: 'visitors.view' },
  { href: '/occurrence-book', label: 'Occurrence Book', permission: 'eob.view' },
  { href: '/hr', label: 'HR', permission: 'notices.view' },
  { href: '/uniform', label: 'Uniform', permission: 'uniform.view' },
  { href: '/reorders', label: 'Re-orders', permission: 'reorders.view' },
  { href: '/scores', label: 'Scores', permission: 'scores.view' },
  { href: '/wire', label: 'The Wire', permission: 'wire.view' },
  { href: '/sites', label: 'Sites', permission: 'sites.view' },
  { href: '/officers', label: 'Officers', permission: 'officers.view' },
  { href: '/training', label: 'Training', permission: 'training.view' },
  { href: '/devices', label: 'Devices', permission: 'devices.view' },
  { href: '/users', label: 'Users', permission: 'users.manage' },
  { href: '/privacy', label: 'Privacy', permission: 'privacy.manage' },
  { href: '/audit', label: 'Audit', permission: 'audit.view' },
];

function Header() {
  const { me, can, signOut } = useSession();
  const path = usePathname();
  return (
    <header className="top">
      <Link href="/" className="brand">
        <img src="/tsf-logo.png" alt="The Security Franchise" />
        <span className="logo">
          On<i>Par</i>
        </span>
      </Link>
      <nav className="nav" aria-label="Main">
        {NAV.filter((n) => !n.permission || can(n.permission)).map((n) => {
          const on = n.href === '/' ? path === '/' : path.startsWith(n.href);
          return (
            <Link key={n.href} href={n.href} className={on ? 'on' : ''} aria-current={on ? 'page' : undefined}>
              {n.label}
            </Link>
          );
        })}
        <AlertsLink />
      </nav>
      <div className="who">
        <div>
          <b>{me.name}</b> · {me.roleLabel}
        </div>
        <div className="mute">
          {me.company.name} · <Link href="/account">My account</Link> ·{' '}
          <button className="btn ghost sm" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}

/** After a temporary password (new account or reset), nothing else is shown until the user chooses their own. */
function Gate({ children }: { children: React.ReactNode }) {
  const { me, can, refresh, signOut } = useSession();
  const path = usePathname();
  // The supervisor app (phone layout) has its own slim frame.
  if (!me.mustChangePassword && (path === '/m' || path.startsWith('/m/'))) return <MobileShell>{children}</MobileShell>;
  if (!me.mustChangePassword) {
    return (
      <>
        <Header />
        {can('attendance.view') && (
          <Link href="/m" className="m-switch">
            Open the phone view <span aria-hidden="true">›</span>
          </Link>
        )}
        {can('panic.view') && <PanicBanner />}
        {can('panic.view') && <BoloBanner />}
        <main className="page">{children}</main>
      </>
    );
  }
  return (
    <main className="login">
      <div className="card">
        <img src="/tsf-logo.png" alt="The Security Franchise" />
        <h2 style={{ marginTop: 10 }}>Choose your own password</h2>
        <p className="mute small">
          Welcome, {me.name.split(' ')[0]}. You signed in with a temporary password. Choose your own to continue; only you will know it.
        </p>
        <ChangePassword email={me.email} onDone={refresh} />
        <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={signOut}>
          Sign out
        </button>
      </div>
    </main>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <Gate>{children}</Gate>
    </SessionProvider>
  );
}
