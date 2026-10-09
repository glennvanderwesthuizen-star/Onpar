'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { keepInStep } from '@/lib/push';
import { ChangePassword } from '@/components/ChangePassword';
import { CustomerProvider, useCustomer } from '@/lib/customer';
import { everyWhileVisible } from '@/lib/poll';

const TABS = [
  { href: '/c', label: 'Home', icon: 'M3 11.5 12 4l9 7.5M5.5 10v9.5h13V10' },
  { href: '/c/visitors', label: 'Visitors', icon: 'M9 11a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 9 11ZM3 19.5a6 6 0 0 1 12 0M16 4.8a3.2 3.2 0 0 1 0 6.2M17.5 14a6 6 0 0 1 3.5 5.5' },
  { href: '/c/book', label: 'Book', icon: 'M5 4.5h11a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3v-12ZM5 16.5a3 3 0 0 1 3-3h11M9 8.5h6', client: true },
  { href: '/c/alerts', label: 'Alerts', icon: 'M12 3.5a6 6 0 0 0-6 6V14l-1.8 3h15.6L18 14V9.5a6 6 0 0 0-6-6ZM9.5 19.5a2.5 2.5 0 0 0 5 0' },
  { href: '/c/account', label: 'My account', icon: 'M12 12a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2ZM4.5 20a7.5 7.5 0 0 1 15 0' },
];

/** The customer app's frame (phase 3, D-39): for the client and tenants of a site, on their own phone. */
function Shell({ children }: { children: React.ReactNode }) {
  const { me, refresh, signOut } = useCustomer();
  const path = usePathname();
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (me.mustChangePassword) return;
    let live = true;
    const check = () =>
      api<{ unread: number }>('/notifications')
        .then((r) => live && setUnread(r.unread))
        .catch(() => undefined);
    check();
    const t = everyWhileVisible(check, 30_000);
    window.addEventListener('onpar:alerts', check);
    return () => {
      live = false;
      t();
      window.removeEventListener('onpar:alerts', check);
    };
  }, [path, me.mustChangePassword]);

  useEffect(() => {
    if (!me.mustChangePassword) keepInStep(me.id);
  }, [me.id, me.mustChangePassword]);

  // After a temporary password (a new account, or a reset), nothing else is shown until they choose their own.
  if (me.mustChangePassword) {
    return (
      <main className="login">
        <div className="card">
          <img src="/tsf-logo.png" alt="The Security Franchise" />
          <h2 style={{ marginTop: 10 }}>Choose your own password</h2>
          <p className="mute small">Welcome, {me.fullName.split(' ')[0]}. You signed in with a temporary password. Choose your own to continue; only you will know it.</p>
          <ChangePassword email={me.email} path="/customer/password" onDone={refresh} />
          <button className="btn ghost sm" style={{ marginTop: 10 }} onClick={signOut}>
            Sign out
          </button>
        </div>
      </main>
    );
  }

  return (
    <div className="m-shell">
      <header className="m-top">
        <Link href="/c" className="brand" aria-label="On Par home">
          <img src="/tsf-logo.png" alt="" />
          <span className="logo">
            On<i>Par</i>
          </span>
        </Link>
        <span className="m-who">
          {me.siteName}
          <span className="mute small">{me.unitName ? `Unit ${me.unitName}` : me.kindLabel}</span>
        </span>
      </header>
      <main className="m-page">{children}</main>
      <nav className="m-tabs c-tabs" aria-label="Customer app">
        {TABS.filter((t) => !('client' in t) || me.kind === 'client').map((t) => {
          const on = t.href === '/c' ? path === '/c' : path.startsWith(t.href);
          return (
            <Link key={t.href} href={t.href} className={on ? 'on' : ''} aria-current={on ? 'page' : undefined}>
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={t.icon} />
              </svg>
              <span>{t.label}</span>
              {t.href === '/c/alerts' && unread > 0 && (
                <b className="count" aria-label={`${unread} unread`}>
                  {unread > 99 ? '99+' : unread}
                </b>
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

export default function CustomerLayout({ children }: { children: React.ReactNode }) {
  return (
    <CustomerProvider>
      <Shell>{children}</Shell>
    </CustomerProvider>
  );
}
