'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { everyWhileVisible } from '@/lib/poll';

/** The supervisor app (plan of 6 Oct 2026, phase 2): what the phone screens show. */

export interface OpenAlert {
  type: 'panic' | 'bolo' | 'patrol_overdue' | 'post_uncovered' | 'red_report';
  id: string;
  siteId: string | null;
  siteName: string;
  at: string;
  title: string;
  detail: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  url: string;
  guardCell: string | null;
}

export interface OnDuty {
  attendanceId: string;
  employeeId: string;
  name: string;
  employeeNumber: string;
  cell: string;
  shiftName: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  dutyOnAt: string;
  late: number;
  relief: 'waiting' | 'uncovered' | 'relieved' | null;
  reliefUnlocksAt: string | null;
}

export interface SiteNow {
  id: string;
  name: string;
  contacts: { kind: 'supervisor' | 'site_manager' | 'control_room'; name: string; phone: string }[];
  openAlerts: number;
  onDuty: OnDuty[];
}

export interface Home {
  now: string;
  sites: SiteNow[];
  alerts: OpenAlert[];
}

const POLL_MS = 15_000;

// One request shared by the page and the Alerts badge (phase 2: they used to ask twice).
let lastHome: { at: number; home: Home } | null = null;
let homeInFlight: Promise<Home> | null = null;

/** The supervisor home, from the server at most every 10 seconds unless `force`d (after an action). */
export function fetchHome(force = false): Promise<Home> {
  if (!force && lastHome && Date.now() - lastHome.at < 10_000) return Promise.resolve(lastHome.home);
  if (!homeInFlight) {
    homeInFlight = api<Home>('/supervisor/home')
      .then((home: Home) => {
        lastHome = { at: Date.now(), home };
        return home;
      })
      .finally(() => (homeInFlight = null));
  }
  return homeInFlight;
}

/**
 * The supervisor's sites and open alerts, refreshed every 15 seconds and whenever the phone
 * comes back to On Par. Keeps showing the last good answer if one refresh fails.
 */
export function useHome() {
  const [data, setData] = useState<Home | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [stale, setStale] = useState(false);
  const live = useRef(true);

  const reload = (force = true) =>
    fetchHome(force)
      .then((h) => {
        if (!live.current) return;
        setData(h);
        setError(null);
        setStale(false);
      })
      .catch((e) => {
        if (!live.current) return;
        setError(e);
        setStale(true);
      });

  useEffect(() => {
    live.current = true;
    reload(false);
    const t = everyWhileVisible(() => reload(false), POLL_MS);
    return () => {
      live.current = false;
      t();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { data, error, stale, reload };
}

/** A time of day in South Africa, for example 17:05. */
export function clock(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleTimeString('en-ZA', { timeZone: 'Africa/Johannesburg', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** How long ago, in plain words: "just now", "4 min ago", "2 h 10 min ago", "3 days ago". */
export function ago(d: string, now: number = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - new Date(d).getTime()) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return mins % 60 ? `${h} h ${mins % 60} min ago` : `${h} h ago`;
  const days = Math.floor(h / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** A phone number as a link the phone can dial. */
export function tel(number: string): string {
  return `tel:${number.replace(/[^\d+]/g, '')}`;
}

export const ALERT_TONE: Record<OpenAlert['type'], 'red' | 'amber'> = {
  panic: 'red',
  post_uncovered: 'red',
  patrol_overdue: 'amber',
  bolo: 'amber',
  red_report: 'red',
};

export const CONTACT_LABEL = { supervisor: 'Supervisor', site_manager: 'Site manager', control_room: 'Control room' } as const;
