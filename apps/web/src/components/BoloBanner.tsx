'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useBanners } from '@/lib/poll';
import { formatDateTime } from '@/components/ui';


/**
 * An orange banner on every page while a BOLO is open (red stays for panic only), checked
 * every 15 seconds, flashing until someone acknowledges it.
 */
export function BoloBanner() {
  const path = usePathname();
  const open = useBanners(path)?.bolos ?? [];
  if (!open.length) return null;
  const n = open[0];
  const waiting = open.filter((b) => !b.acknowledgedAt).length;
  const place = [n.siteName ?? 'No site', n.postName, n.deviceLabel].filter(Boolean).join(' · ');
  return (
    <div className={`bolo-banner${waiting ? ' flash' : ''}`} role="alert">
      <b>BOLO</b>
      <span>
        {open.length === 1 ? place : `${open.length} open BOLOs. Newest: ${place}`} · {formatDateTime(n.reportedAt)}
        {n.employeeName && ` · ${n.employeeName}`}
        {waiting ? ` · ${waiting} not yet seen` : ' · seen'}
      </span>
      {!path.startsWith('/reports/bolo') && (
        <Link className="btn sm" href="/reports/bolo">
          Open
        </Link>
      )}
    </div>
  );
}
