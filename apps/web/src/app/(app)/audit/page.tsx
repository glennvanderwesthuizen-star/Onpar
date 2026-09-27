'use client';

import { api } from '@/lib/api';
import { ErrorBanner, formatDateTime, useLoad } from '@/components/ui';

interface Entry {
  id: string;
  at: string;
  actor_type: string;
  actor_label: string;
  action: string;
  entity_type: string;
  reason: string | null;
  after: Record<string, unknown> | null;
}

const ACTIONS: Record<string, string> = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed sign-in',
  'site.create': 'Created site',
  'site.update': 'Edited site',
  'officer.enrol': 'Enrolled officer',
  'officer.photo_view': 'Viewed officer photo',
  'officer.pin_reset': 'Reset officer PIN',
  'device.register': 'Registered device',
  'device.update': 'Changed device',
  'guard.login': 'Guard logged in on device',
  'guard.login_failed': 'Guard entered wrong PIN',
  'guard.locked_out': 'Guard locked out after 5 wrong PINs',
  'attendance.duty_on': 'Duty On',
  'attendance.duty_from': 'Duty From',
  'attendance.declaration': 'Made declaration',
  'attendance.duty_on_on_behalf': 'Logged Duty On for an officer',
  'attendance.duty_from_on_behalf': 'Logged Duty From for an officer',
  'attendance.exception': 'Approved attendance exception',
  'attendance.selfie_view': 'Viewed declaration selfie',
  'task.create': 'Created task',
  'task.update': 'Edited task',
  'task.stop': 'Stopped task',
  'task.review': 'Reviewed "could not complete"',
  'score.award': 'Awarded points',
  'score.reverse': 'Reversed points',
  'score.query_answer': 'Answered a score query',
  'score.rules': 'Changed scoring rules',
  'report.create': 'Made a report',
  'report.assign': 'Assigned a report',
  'report.actioned': 'Recorded report work as done',
  'report.attendance_checked': 'Confirmed attendance on a report',
  'report.close': 'Closed a report',
  'people.create': 'Added to people directory',
  'people.update': 'Changed people directory',
  'patrol.type_create': 'Added a patrol type',
  'patrol.type_update': 'Changed a patrol type',
  'patrol.rules': 'Set patrol rules',
  'patrol.rules_remove': 'Removed patrol rules',
  'patrol.allocation': 'Set patrol points allocation',
  'patrol.point_create': 'Added a patrol point',
  'patrol.point_update': 'Changed a patrol point',
  'patrol.alert_ack': 'Acknowledged a patrol alert',
  'patrol.alert_safe': 'Confirmed a guard is safe',
  'patrol.review': 'Reviewed a patrol ended early',
  'reorder.ordered': 'Marked a re-order as ordered',
  'reorder.assigned': 'Assigned a re-order for delivery',
  'reorder.delivered': 'Marked a re-order as delivered',
  'kit.catalogue': 'Changed the kit list',
  'kit.issue': 'Issued kit to an officer',
  'training.record': 'Recorded a qualification',
  'training.correct': 'Corrected a qualification',
  'officer.psira_update': 'Updated PSIRA details',
};

function subject(e: Entry): string {
  const a = e.after ?? {};
  return String(a.name ?? a.title ?? a.fullName ?? a.officer ?? a.label ?? a.kind ?? a.siteName ?? '');
}

export default function AuditPage() {
  const { data, error } = useLoad(() => api<Entry[]>('/audit?limit=300'));
  return (
    <>
      <div className="head">
        <div>
          <h1>Audit log</h1>
          <p className="mute">Every action, newest first. Entries can never be edited or deleted.</p>
        </div>
      </div>
      <ErrorBanner error={error} />
      <div className="card scroll">
        {data && (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>What</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {data.map((e) => (
                <tr key={e.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{formatDateTime(e.at)}</td>
                  <td>
                    {e.actor_label || e.actor_type}
                    {e.actor_type !== 'user' && <div className="mute small">{e.actor_type}</div>}
                  </td>
                  <td>
                    {ACTIONS[e.action] ?? e.action}
                    {subject(e) && <div className="mute small">{subject(e)}</div>}
                  </td>
                  <td>{e.reason ?? <span className="mute">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
