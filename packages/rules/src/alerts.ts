import { can, Permission, Role } from './roles';

/**
 * Alerts sent to a person's own phone (plan of 6 Oct 2026, decision D-38). One list for every
 * app, so the alerts page, the settings and the server always agree.
 */
export const ALERT_KINDS = ['test', 'panic', 'bolo', 'patrol_overdue', 'post_uncovered', 'wrong_post', 'red_report', 'visitor_barred', 'visitor_exception', 'visitor_overstay', 'visitor_handover', 'visitor_request', 'visitor_answered', 'visitor_arrived', 'visitor_pass_ending', 'visitor_left', 'visitor_exit_exception', 'visitor_still_on_site', 'wire_waiting', 'roll_call'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export interface AlertInfo {
  label: string;
  /** What the settings page says about it. */
  about: string;
  /** Only people whose role has this permission can receive it. Null: anyone. */
  permission: Permission | null;
  /** Whether a person may switch it off for themselves. A panic can never be switched off. */
  optional: boolean;
  /** Sent to customers (the client and tenants of a site), never to staff. */
  customer?: boolean;
  /** For information only: there is nothing to answer, so it does not add to the red count of unread alerts. */
  info?: boolean;
}

export const ALERT_INFO: Record<AlertKind, AlertInfo> = {
  test: { label: 'Test alert', about: 'Sent when you press "Send me a test alert".', permission: null, optional: false },
  panic: { label: 'Panic', about: 'A guard pressed PANIC at one of your sites.', permission: 'panic.view', optional: false },
  bolo: { label: 'BOLO', about: 'A guard sent a BOLO from one of your sites.', permission: 'reports.view', optional: true },
  patrol_overdue: { label: 'Patrol overdue', about: 'A patrol was started and not finished in time.', permission: 'patrols.alerts', optional: true },
  post_uncovered: { label: 'Post uncovered', about: 'A relief guard has not arrived and the post is uncovered.', permission: 'attendance.view', optional: true },
  wrong_post: { label: 'Guard at another position', about: 'A guard who is locked to one position came on duty on another position’s phone.', permission: 'attendance.view', optional: true },
  red_report: { label: 'Red report', about: 'A report with Red priority was raised.', permission: 'reports.view', optional: true },
  roll_call: { label: 'Emergency roll-call', about: 'An emergency roll-call was started at one of your sites: everyone on site is to be ticked off at the assembly point.', permission: 'visitors.view', optional: false },
  visitor_barred: { label: 'Barred visitor', about: 'Someone on the barred list tried to come in at one of your gates.', permission: 'visitors.view', optional: true },
  visitor_exception: { label: 'Visitor exception', about: 'Something did not match when a visitor left, or a visitor was scanned in while still recorded as on site.', permission: 'visitors.view', optional: true },
  visitor_overstay: { label: 'Visitor overstay', about: 'A visitor is still on site past their time and the gate guard has not dealt with it.', permission: 'visitors.view', optional: true },
  visitor_handover: { label: 'Visitor handover', about: 'A gate guard handed over his shift with an overstay still unresolved.', permission: 'visitors.view', optional: true },
  visitor_request: { label: 'Visitor at the gate', about: 'A visitor is at the gate asking for you.', permission: null, optional: false, customer: true },
  visitor_answered: { label: 'Visitor answered', about: 'A visitor request for your unit was answered.', permission: null, optional: false, customer: true, info: true },
  visitor_arrived: { label: 'Visitor arrived', about: 'A visitor you told the gate about has arrived.', permission: null, optional: true, customer: true, info: true },
  visitor_pass_ending: { label: 'Regular visitor ending', about: 'A contractor you set up for a fixed period has three days left.', permission: null, optional: false, customer: true },
  visitor_left: { label: 'Visitor left', about: 'A visitor to your unit was scanned out at the gate.', permission: null, optional: true, customer: true, info: true },
  visitor_exit_exception: { label: 'Visitor exception', about: 'Something did not match when a visitor to your unit left.', permission: null, optional: false, customer: true },
  wire_waiting: { label: 'The Wire: waiting for you', about: 'A Thuthuka note, an award or a hand-in has waited too long for a decision.', permission: 'wire.manage', optional: true },
  visitor_still_on_site: { label: 'Still on site', about: 'A contractor or visitor of yours is still on site past the time they were due to leave.', permission: null, optional: false, customer: true },
};

/** The alerts a role can receive, in display order. The test alert is not a setting, so it is left out. */
export function alertKindsFor(role: Role): AlertKind[] {
  return ALERT_KINDS.filter((k) => k !== 'test' && !ALERT_INFO[k].customer && (ALERT_INFO[k].permission === null || can(role, ALERT_INFO[k].permission as Permission)));
}

/**
 * Whether a person gets this alert: their role must allow it, and they must not have switched
 * it off (alerts that cannot be switched off ignore the setting).
 */
export function wantsAlert(role: Role, kind: AlertKind, switchedOff: ReadonlySet<string>): boolean {
  const info = ALERT_INFO[kind];
  if (info.customer) return false;
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
