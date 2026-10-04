'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ErrorBanner, useLoad } from '@/components/ui';
import { IdBadge } from '@/components/TsfPlate';

interface BadgeRow {
  id: string;
  fullName: string;
  tsfNumber: string | null;
  siteId: string;
  siteName: string;
  hasPhoto: boolean;
  qr: string;
}

/**
 * Guard ID badges to print (owner's design, 4 Oct 2026). Every active guard has a card ready
 * from enrolment. Two layouts: a sheet of 10 for your own printer, or one badge per page with
 * crop marks for a print shop (save it as a PDF from the print window).
 */
export default function IdCardsPage() {
  const sites = useLoad(() => api<{ id: string; name: string }[]>('/sites'));
  const [siteId, setSiteId] = useState('');
  const { data, error } = useLoad(() => api<BadgeRow[]>(`/badges${siteId ? `?siteId=${siteId}` : ''}`), [siteId]);
  const [ids, setIds] = useState<string[] | null>(null);
  const [shop, setShop] = useState(false);
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get('ids');
    if (v) setIds(v.split(',').filter(Boolean));
  }, []);

  const shown = (data ?? []).filter((o) => !ids || ids.includes(o.id));
  const noPhoto = shown.filter((o) => !o.hasPhoto).length;

  return (
    <>
      <div className="head no-print">
        <div>
          <Link href="/officers" className="mute small">
            ← Officers
          </Link>
          <h1>ID badges</h1>
          <p className="mute">
            Logo, photo, full name and a QR code, nothing else. The QR code holds only a random card code: the guard
            scans it at the post phone and types his PIN; a supervisor who scans it must sign in to see his record.
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
                {sites.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <select style={{ width: 230 }} value={shop ? 'shop' : 'sheet'} onChange={(e) => setShop(e.target.value === 'shop')} aria-label="Layout">
            <option value="sheet">My printer: 10 on an A4 page</option>
            <option value="shop">Print shop: 1 per page, crop marks</option>
          </select>
          <button className="btn" disabled={!shown.length} onClick={() => window.print()}>
            {shop ? 'Print or save as PDF' : 'Print'} ({shown.length})
          </button>
        </div>
      </div>
      <ErrorBanner error={error} />
      {shop && (
        <div className="banner no-print">
          For a print shop: press the button, choose <b>Save as PDF</b> as the printer, and set the paper size to the
          shop&apos;s size (each page is 92 × 60 mm: an 86 × 54 mm badge with 3 mm to trim all round). Send them the PDF.
        </div>
      )}
      {noPhoto > 0 && (
        <div className="banner warn no-print">
          {noPhoto} guard{noPhoto === 1 ? ' has' : 's have'} no face photo, so the badge shows a blank space.
        </div>
      )}
      {data && !shown.length && <div className="card mute no-print">No badges to print.</div>}
      <div className={`id-sheet${shop ? ' shop' : ''}`}>
        {shown.map((o) => {
          const badge = <IdBadge key={o.id} qr={o.qr} name={o.fullName} photoPath={o.hasPhoto ? `/officers/${o.id}/photos/face?purpose=badge` : null} />;
          return shop ? (
            <div key={o.id} className="shop-page">
              {['tl', 'tr', 'bl', 'br'].map((c) => (
                <span key={c} className={`crop ${c}`} />
              ))}
              {badge}
            </div>
          ) : (
            badge
          );
        })}
      </div>
    </>
  );
}
