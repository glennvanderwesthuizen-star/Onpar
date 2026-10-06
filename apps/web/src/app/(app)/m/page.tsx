'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ErrorBanner } from '@/components/ui';
import { useSession } from '@/lib/session';
import { ago, ALERT_TONE, clock, CONTACT_LABEL, tel, useHome } from '@/lib/supervisor';

/** Supervisor app, Home: open alerts first, then each site with who is on duty now. */
export default function MobileHome() {
  const { me, can } = useSession();
  const router = useRouter();
  const allowed = can('attendance.view');
  useEffect(() => {
    // Roles without attendance (HR, payroll, stores, clients) use the full website.
    if (!allowed) router.replace('/');
  }, [allowed, router]);
  const { data, error, stale } = useHome();
  if (!allowed) return null;

  const panics = data?.alerts.filter((a) => a.type === 'panic') ?? [];
  const others = data ? data.alerts.length - panics.length : 0;

  return (
    <>
      <h1 className="m-h1">Hello, {me.name.split(' ')[0]}</h1>
      {stale && <div className="banner warn">No connection. Showing the last update{data ? ` from ${clock(data.now)}` : ''}.</div>}
      {!data && <ErrorBanner error={error} />}
      {!data && !error && <p className="mute">Loading…</p>}

      {data && (
        <>
          {panics.map((p) => (
            <Link key={p.id} href={p.url} className="m-panic" role="alert">
              <b>PANIC</b>
              <span>
                {p.siteName}
                {p.detail ? ` · ${p.detail}` : ''}
              </span>
              <span className="small">
                {ago(p.at)} · {p.acknowledgedAt ? `acknowledged by ${p.acknowledgedBy ?? 'someone'}` : 'not yet acknowledged'}
              </span>
            </Link>
          ))}

          {data.alerts.length === 0 ? (
            <div className="m-allclear">
              <b>Nothing needs your attention.</b>
              <span className="mute small">Checked at {clock(data.now)}. This page updates by itself.</span>
            </div>
          ) : (
            others > 0 && (
              <Link href="/m/alerts" className="m-strip">
                <b>
                  {others} other thing{others === 1 ? '' : 's'} need{others === 1 ? 's' : ''} attention
                </b>
                <span aria-hidden="true">›</span>
              </Link>
            )
          )}

          <h2 className="m-h2">Your sites</h2>
          {data.sites.length === 0 && <div className="card">You are not linked to any site yet. Ask an administrator to add your sites on the Users page.</div>}
          {data.sites.map((s) => {
            const uncovered = s.onDuty.filter((g) => g.relief === 'uncovered').length;
            const control = s.contacts.find((c) => c.kind === 'control_room');
            return (
              <section key={s.id} className="card m-site">
                <div className="m-site-head">
                  <h3>{s.name}</h3>
                  {s.openAlerts > 0 && <span className={`pill ${data.alerts.some((a) => a.siteId === s.id && ALERT_TONE[a.type] === 'red') ? 'red' : 'amber'}`}>{s.openAlerts} open</span>}
                </div>
                <p className={s.onDuty.length ? '' : 'mute'}>
                  {s.onDuty.length === 0 ? 'Nobody is on duty.' : `${s.onDuty.length} on duty`}
                  {uncovered > 0 && <b className="m-bad"> · {uncovered} post{uncovered === 1 ? '' : 's'} uncovered</b>}
                </p>
                {s.onDuty.length > 0 && (
                  <ul className="m-list">
                    {s.onDuty.map((g) => (
                      <li key={g.attendanceId}>
                        <span>
                          {g.name}
                          <span className="mute small"> · on since {clock(g.dutyOnAt)}</span>
                        </span>
                        {g.relief === 'uncovered' ? <span className="pill red">No relief</span> : g.relief === 'waiting' ? <span className="pill amber">Waiting for relief</span> : g.late > 0 ? <span className="pill amber">Late {g.late} min</span> : null}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="m-actions">
                  <Link className="btn ghost" href={`/m/duty#${s.id}`}>
                    Guards on duty
                  </Link>
                  {control && (
                    <a className="btn ghost" href={tel(control.phone)}>
                      Call {CONTACT_LABEL.control_room.toLowerCase()}
                    </a>
                  )}
                </div>
              </section>
            );
          })}
        </>
      )}
    </>
  );
}
