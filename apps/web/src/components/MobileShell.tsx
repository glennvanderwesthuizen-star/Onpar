'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { keepInStep } from '@/lib/push';
import { useSession } from '@/lib/session';

const TABS = [
  { href: '/m', label: 'Home', icon: 'M3 11.5 12 4l9 7.5M5.5 10v9.5h13V10' },
  { href: '/m/alerts', label: 'Alerts', icon: 'M12 3.5a6 6 0 0 0-6 6V14l-1.8 3h15.6L18 14V9.5a6 6 0 0 0-6-6ZM9.5 19.5a2.5 2.5 0 0 0 5 0' },
  { href: '/m/duty', label: 'On duty', icon: 'M12 12a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2ZM4.5 20a7.5 7.5 0 0 1 15 0' },
];

/**
 * The frame of the supervisor app on a phone: a slim header and three large tabs at the
 * bottom, within reach of a thumb. The full website stays one tap away.
 */
export function MobileShell({ children }: { children: React.ReactNode }) {
  const { me } = useSession();
  const path = usePathname();
  const [open, setOpen] = useState(0);

  // How many things are open, for the badge on the Alerts tab.
  useEffect(() => {
    let live = true;
    const check = () =>
      api<{ alerts: unknown[] }>('/supervisor/home')
        .then((h) => live && setOpen(h.alerts.length))
        .catch(() => undefined);
    check();
    const t = setInterval(check, 15_000);
    window.addEventListener('onpar:alerts', check);
    return () => {
      live = false;
      clearInterval(t);
      window.removeEventListener('onpar:alerts', check);
    };
  }, [path]);

  useEffect(() => {
    keepInStep(me.id);
  }, [me.id]);

  return (
    <div className="m-shell">
      <header className="m-top">
        <Link href="/m" className="brand" aria-label="On Par home">
          <img src="/tsf-logo.png" alt="" />
          <span className="logo">
            On<i>Par</i>
          </span>
        </Link>
        <Link href="/account" className="m-who">
          {me.name.split(' ')[0]}
          <span className="mute small">My account</span>
        </Link>
      </header>
      <main className="m-page">{children}</main>
      <nav className="m-tabs" aria-label="Supervisor app">
        {TABS.map((t) => {
          const on = t.href === '/m' ? path === '/m' : path.startsWith(t.href) || (t.href === '/m/alerts' && path.startsWith('/m/panic'));
          return (
            <Link key={t.href} href={t.href} className={on ? 'on' : ''} aria-current={on ? 'page' : undefined}>
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={t.icon} />
              </svg>
              <span>{t.label}</span>
              {t.href === '/m/alerts' && open > 0 && (
                <b className="count" aria-label={`${open} open`}>
                  {open > 99 ? '99+' : open}
                </b>
              )}
            </Link>
          );
        })}
        <Link href="/">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M4 6.5h16M4 12h16M4 17.5h16" />
          </svg>
          <span>Full site</span>
        </Link>
      </nav>
    </div>
  );
}
