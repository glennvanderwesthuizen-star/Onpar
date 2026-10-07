'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { formatDateTime } from '@/components/ui';

export interface PanicAlert {
  id: string;
  raisedAt: string;
  lateSynced: boolean;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  locationMock: boolean;
  callStarted: boolean;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  siteId: string | null;
  siteName: string | null;
  deviceLabel: string;
  postName: string | null;
  employeeName: string | null;
  employeeNumber: string | null;
  emergencyCalls?: EmergencyCall[];
}

/** An emergency number the guard tapped after a panic. The number itself is not kept. */
export interface EmergencyCall {
  service: 'police' | 'fire' | 'ambulance' | 'armed_response';
  national: boolean;
  calledAt: string;
  by: string | null;
}
const SERVICE: Record<EmergencyCall['service'], string> = { police: 'Police', fire: 'Fire brigade', ambulance: 'Ambulance', armed_response: 'Armed response' };
export function emergencyCallText(c: EmergencyCall): string {
  if (c.service === 'armed_response') return SERVICE[c.service];
  return `${SERVICE[c.service]} (${c.national ? 'national number' : c.service === 'police' ? 'local station' : 'local number'})`;
}

const POLL_MS = 15_000;

/** Where a panic came from, in one line. */
export function panicPlace(p: PanicAlert) {
  return [p.siteName ?? 'No site', p.postName, p.deviceLabel].filter(Boolean).join(' · ');
}

/**
 * A red banner on every page while a panic is open, checked every 15 seconds.
 * Shown only to people who may see panics (managers and supervisors).
 */
export function PanicBanner() {
  const [open, setOpen] = useState<PanicAlert[]>([]);
  const path = usePathname();
  useEffect(() => {
    let live = true;
    const check = () =>
      api<PanicAlert[]>('/panic')
        .then((rows) => live && setOpen(rows))
        .catch(() => undefined);
    check();
    const t = setInterval(check, POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [path]);

  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) PANIC · /, '');
    const waiting = open.filter((p) => !p.acknowledgedAt).length;
    document.title = waiting ? `(${waiting}) PANIC · ${base}` : base;
  }, [open]);

  if (!open.length) return null;
  const newest = open[0];
  const waiting = open.filter((p) => !p.acknowledgedAt).length;
  return (
    <div className={`panic-banner${waiting ? ' flash' : ''}`} role="alert">
      <b>PANIC</b>
      <span>
        {open.length === 1 ? panicPlace(newest) : `${open.length} open panics. Newest: ${panicPlace(newest)}`}
        {' · '}
        {formatDateTime(newest.raisedAt)}
        {newest.employeeName && ` · ${newest.employeeName}`}
        {waiting ? ` · ${waiting} not yet acknowledged` : ' · acknowledged'}
      </span>
      {!path.startsWith('/panic') && (
        <Link className="btn sm" href="/panic">
          Open
        </Link>
      )}
    </div>
  );
}
