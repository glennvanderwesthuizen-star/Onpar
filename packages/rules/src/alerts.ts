import { can, Permission, Role } from './roles';

/**
 * Alerts sent to a person's own phone (plan of 6 Oct 2026, decision D-38). One list for every
 * app, so the alerts page, the settings and the server always agree.
 */
export const ALERT_KINDS = ['test', 'panic', 'bolo', 'patrol_overdue', 'post_uncovered', 'red_report', 'visitor_barred'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export interface AlertInfo {
  label: string;
  /** What the settings page says about it. */
  about: string;
  /** Only people whose role has this permission can receive it. Null: anyone. */
  permission: Permission | null;
  /** Whether a person may switch it off for themselves. A panic can never be switched off. */
  optional: boolean;
}

export const ALERT_INFO: Record<AlertKind, AlertInfo> = {
  test: { label: 'Test alert', about: 'Sent when you press "Send me a test alert".', permission: null, optional: false },
  panic: { label: 'Panic', about: 'A guard pressed PANIC at one of your sites.', permission: 'panic.view', optional: false },
  bolo: { label: 'BOLO', about: 'A guard sent a BOLO from one of your sites.', permission: 'reports.view', optional: true },
  patrol_overdue: { label: 'Patrol overdue', about: 'A patrol was started and not finished in time.', permission: 'patrols.alerts', optional: true },
  post_uncovered: { label: 'Post uncovered', about: 'A relief guard has not arrived and the post is uncovered.', permission: 'attendance.view', optional: true },
  red_report: { label: 'Red report', about: 'A report with Red priority was raised.', permission: 'reports.view', optional: true },
  visitor_barred: { label: 'Barred visitor', about: 'Someone on the barred list tried to come in at one of your gates.', permission: 'visitors.view', optional: true },
};

/** The alerts a role can receive, in display order. The test alert is not a setting, so it is left out. */
export function alertKindsFor(role: Role): AlertKind[] {
  return ALERT_KINDS.filter((k) => k !== 'test' && (ALERT_INFO[k].permission === null || can(role, ALERT_INFO[k].permission as Permission)));
}

/**
 * Whether a person gets this alert: their role must allow it, and they must not have switched
 * it off (alerts that cannot be switched off ignore the setting).
 */
export function wantsAlert(role: Role, kind: AlertKind, switchedOff: ReadonlySet<string>): boolean {
  const info = ALERT_INFO[kind];
  if (info.permission !== null && !can(role, info.permission)) return false;
  return !info.optional || !switchedOff.has(kind);
}

/**
 * The delivery services phone and computer browsers use for alerts (Google, Apple, Mozilla,
 * Microsoft). The server only ever sends alerts to these, never to an address a browser made up.
 */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /\.push\.apple\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];

export function isPushEndpoint(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && !u.username && !u.password && (u.port === '' || u.port === '443') && PUSH_HOSTS.some((h) => h.test(u.hostname));
}

/** A short name for the phone or computer an alert goes to, from what its browser says about itself. */
export function deviceLabel(userAgent: string): string {
  const ua = userAgent ?? '';
  const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet') : /Windows/.test(ua) ? 'Windows computer' : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux computer' : 'Device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? `${device} (${browser})` : device;
}
