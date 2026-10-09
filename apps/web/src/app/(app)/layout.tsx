'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { SessionProvider, useSession } from '@/lib/session';
import { ChangePassword } from '@/components/ChangePassword';
import { PanicBanner } from '@/components/PanicBanner';
import { BoloBanner } from '@/components/BoloBanner';
import { AlertsLink } from '@/components/AlertsLink';
import { MobileShell } from '@/components/MobileShell';

/**
 * The menu in six headings (optimisation review, phase 3: 24 links in one row had become hard
 * to scan). Headings and order are easy to change here as the owner adjusts them.
 */
const MENU: { heading: string; items: { href: string; label: string; permission: string | null; also?: string[] }[] }[] = [
  {
    heading: 'On duty now',
    items: [
      { href: '/', label: 'Overview', permission: null },
      { href: '/panic', label: 'Panic', permission: 'panic.view' },
      { href: '/patrols', label: 'Patrols', permission: 'patrols.view' },
      { href: '/reports', label: 'Reports', permission: 'reports.view' },
      { href: '/occurrence-book', label: 'Occurrence Book', permission: 'eob.view' },
    ],
  },
  {
    heading: 'Shifts',
    items: [
      { href: '/roster', label: 'Roster', permission: 'roster.view' },
      { href: '/attendance', label: 'Attendance', permission: 'attendance.view' },
      { href: '/register', label: 'Register', permission: 'register.view' },
      { href: '/tasks', label: 'Tasks', permission: 'tasks.view' },
    ],
  },
  {
    heading: 'Sites and gates',
    items: [
      { href: '/sites', label: 'Sites', permission: 'sites.view' },
      { href: '/visitors', label: 'Visitors', permission: 'visitors.view' },
      { href: '/devices', label: 'Devices', permission: 'devices.view' },
    ],
  },
  {
    heading: 'People',
    items: [
      { href: '/officers', label: 'Officers', permission: 'officers.view' },
      { href: '/training', label: 'Training', permission: 'training.view' },
      { href: '/scores', label: 'Scores', permission: 'scores.view' },
      { href: '/wire', label: 'The Wire', permission: 'wire.view' },
      { href: '/hr', label: 'HR', permission: 'notices.view' },
    ],
  },
  {
    heading: 'Stores',
    items: [
      // One place for uniform, equipment and site supplies (owner, 9 Oct 2026): see `storesEntry`.
      { href: '/uniform', label: 'Uniform and re-orders', permission: null, also: ['/reorders'] },
    ],
  },
  {
    heading: 'Company',
    items: [
      { href: '/users', label: 'Users', permission: 'users.manage' },
      { href: '/privacy', label: 'Privacy', permission: 'privacy.manage' },
      { href: '/audit', label: 'Audit', permission: 'audit.view' },
    ],
  },
];

function isOn(path: string, href: string, also: string[] = []) {
  if (href === '/') return path === '/';
  return [href, ...also].some((h) => path === h || path.startsWith(`${h}/`));
}

/** Stores is one entry, named for what the person may see: uniform orders, re-orders, or both (as tabs). */
function storesEntry(can: (p: string) => boolean) {
  const uniform = can('uniform.view');
  const reorders = can('reorders.view');
  if (uniform) return { href: '/uniform', label: reorders ? 'Uniform and re-orders' : 'Uniform', permission: null, also: ['/reorders'] };
  if (reorders) return { href: '/reorders', label: 'Re-orders', permission: null, also: ['/uniform'] };
  return null;
}

function Menu({ onPick }: { onPick: () => void }) {
  const { can } = useSession();
  const path = usePathname();
  return (
    <nav className="menu" aria-label="Main">
      {MENU.map((g) => {
        const stores = g.heading === 'Stores' ? storesEntry(can) : undefined;
        const items = stores !== undefined ? (stores ? [stores] : []) : g.items.filter((n) => !n.permission || can(n.permission));
        if (!items.length) return null;
        return (
          <div className="menu-group" key={g.heading}>
            <h2>{g.heading}</h2>
            {items.map((n) => {
              const on = isOn(path, n.href, n.also);
              return (
                <Link key={n.href} href={n.href} className={on ? 'on' : ''} aria-current={on ? 'page' : undefined} onClick={onPick}>
                  {n.label}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { me, can, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const path = usePathname();
  // Closes the menu on a phone-sized screen after a page is chosen.
  useEffect(() => setOpen(false), [path]);
  return (
    <div className={`shell${open ? ' menu-open' : ''}`}>
      <aside className="side">
        <div className="side-top">
          <Link href="/" className="brand">
            <img src="/tsf-logo.png" alt="The Security Franchise" />
            <span className="logo">
              On<i>Par</i>
            </span>
          </Link>
          <button className="menu-toggle" aria-expanded={open} aria-controls="main-menu" onClick={() => setOpen(!open)}>
            {open ? 'Close' : 'Menu'}
          </button>
        </div>
        <div id="main-menu" className="side-body">
          <Menu onPick={() => setOpen(false)} />
          <div className="who">
            <b>{me.name}</b>
            <span>{me.roleLabel}, {me.company.name}</span>
            <div className="who-links">
              <Link href="/account">My account</Link>
              {can('attendance.view') && <Link href="/m">Phone view</Link>}
              <button onClick={signOut}>Sign out</button>
            </div>
          </div>
        </div>
      </aside>
      <div className="main">
        <div className="main-bar">
          <AlertsLink />
        </div>
        {can('panic.view') && <PanicBanner />}
        {can('panic.view') && <BoloBanner />}
        <main className="page">{children}</main>
      </div>
    </div>
  );
}

/** After a temporary password (new account or reset), nothing else is shown until the user chooses their own. */
function Gate({ children }: { children: React.ReactNode }) {
  const { me, can, refresh, signOut } = useSession();
  const path = usePathname();
  // The supervisor app (phone layout) has its own slim frame.
  if (!me.mustChangePassword && (path === '/m' || path.startsWith('/m/'))) return <MobileShell>{children}</MobileShell>;
  if (!me.mustChangePassword) {
    return <Shell>{children}</Shell>;
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
