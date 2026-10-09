'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { useBanners } from '@/lib/poll';
import { keepInStep } from '@/lib/push';
import { useSession } from '@/lib/session';

/** The Alerts link in the header, with how many are unread. Checked every 30 seconds and on each page change. */
export function AlertsLink() {
  const { me } = useSession();
  const path = usePathname();
  const unread = useBanners(path)?.unread ?? 0;
  const on = path.startsWith('/alerts');

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
