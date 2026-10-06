'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { keepInStep } from '@/lib/push';
import { useSession } from '@/lib/session';

const POLL_MS = 30_000;

/** The Alerts link in the header, with how many are unread. Checked every 30 seconds and on each page change. */
export function AlertsLink() {
  const { me } = useSession();
  const path = usePathname();
  const [unread, setUnread] = useState(0);
  const on = path.startsWith('/alerts');

  useEffect(() => {
    let live = true;
    const check = () =>
      api<{ unread: number }>('/notifications')
        .then((r) => live && setUnread(r.unread))
        .catch(() => undefined);
    check();
    const t = setInterval(check, POLL_MS);
    window.addEventListener('onpar:alerts', check);
    return () => {
      live = false;
      clearInterval(t);
      window.removeEventListener('onpar:alerts', check);
    };
  }, [path]);

  // Browsers sometimes renew their alert address; keep the server's copy current.
  useEffect(() => {
    keepInStep(me.id);
  }, [me.id]);

  return (
    <Link href="/alerts" className={on ? 'on' : ''} aria-current={on ? 'page' : undefined}>
      Alerts
      {unread > 0 && (
        <span className="count" aria-label={`${unread} unread`}>
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </Link>
  );
}
