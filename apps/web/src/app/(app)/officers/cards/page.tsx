'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ErrorBanner, useLoad } from '@/components/ui';
import { IdCard } from '@/components/TsfPlate';

interface OfficerRow {
  id: string;
  full_name: string;
  tsf_number: string | null;
  status: string;
  site_id: string;
  site_name: string;
}

/**
 * Guard ID cards to print: credit-card size, 10 to an A4 page. Each card has only the company
 * logo, the QR code with the guard's TSF number, and their name (owner, 4 Oct 2026, for POPIA).
 */
export default function IdCardsPage() {
  const { data, error } = useLoad(() => api<OfficerRow[]>('/officers'));
  const [ids, setIds] = useState<string[] | null>(null);
  const [siteId, setSiteId] = useState('');
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get('ids');
    if (v) setIds(v.split(',').filter(Boolean));
  }, []);

  const withNumber = (data ?? []).filter((o) => o.status === 'active' && o.tsf_number);
  const waiting = (data ?? []).filter((o) => o.status === 'active' && !o.tsf_number && (!siteId || o.site_id === siteId));
  const shown = ids ? withNumber.filter((o) => ids.includes(o.id)) : withNumber.filter((o) => !siteId || o.site_id === siteId);
  const sites = [...new Map((data ?? []).map((o) => [o.site_id, o.site_name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));

  return (
    <>
      <div className="head no-print">
        <div>
          <Link href="/officers" className="mute small">
            ← Officers
          </Link>
          <h1>ID cards</h1>
          <p className="mute">
            Each card shows only the QR code and the guard&apos;s name. At the post phone the guard scans it, then types
            their PIN. Print on card stock, 10 to an A4 page, and cut out.
          </p>
        </div>
        <div className="row">
          {ids ? (
            <button className="btn ghost" onClick={() => setIds(null)}>
              Show all guards
            </button>
          ) : (
            <div style={{ width: 220 }}>
              <select value={siteId} onChange={(e) => setSiteId(e.target.value)} aria-label="Site">
                <option value="">All my sites</option>
                {sites.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <button className="btn" disabled={!shown.length} onClick={() => window.print()}>
            Print {shown.length} card{shown.length === 1 ? '' : 's'}
          </button>
        </div>
      </div>
      <ErrorBanner error={error} />
      {!ids && waiting.length > 0 && (
        <div className="banner warn no-print">
          {waiting.length} guard{waiting.length === 1 ? ' has' : 's have'} no TSF number yet because their site has no
          province. Set the province on the site and the numbers are issued straight away.
        </div>
      )}
      {data && !shown.length && <div className="card mute no-print">No ID cards to print.</div>}
      <div className="id-sheet">
        {shown.map((o) => (
          <IdCard key={o.id} tsfNumber={o.tsf_number!} name={o.full_name} />
        ))}
      </div>
    </>
  );
}
