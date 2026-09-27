'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SessionProvider, useSession } from '@/lib/session';

const NAV = [
  { href: '/', label: 'Overview', permission: null },
  { href: '/sites', label: 'Sites', permission: 'sites.view' },
  { href: '/officers', label: 'Officers', permission: 'officers.view' },
  { href: '/devices', label: 'Devices', permission: 'devices.view' },
  { href: '/audit', label: 'Audit log', permission: 'audit.view' },
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
      </nav>
      <div className="who">
        <div>
          <b>{me.name}</b> · {me.roleLabel}
        </div>
        <div className="mute">
          {me.company.name} ·{' '}
          <button className="btn ghost sm" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <Header />
      <main className="page">{children}</main>
    </SessionProvider>
  );
}
