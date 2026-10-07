'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, useLoad } from './ui';

interface Postings {
  positions: { deviceId: string; name: string }[];
  guards: { employeeId: string; name: string; deviceId: string | null }[];
}

/**
 * Lock or roam (owner, 7 Oct 2026). Each guard of the site is locked to one position (a post
 * phone, such as Main gate) or roams. A locked guard is the primary on his position's phone
 * while he is on duty there. Where nobody is locked, the first guard on duty is the primary.
 */
export function SitePostings({ siteId }: { siteId: string }) {
  const { can } = useSession();
  const allowed = can('roster.view');
  const manage = can('roster.manage');
  const empty: Postings = { positions: [], guards: [] };
  const { data, error, reload } = useLoad(() => (allowed ? api<Postings>(`/sites/${siteId}/postings`) : Promise.resolve(empty)), [siteId, allowed]);
  const [saving, setSaving] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  if (!allowed) return null;

  async function set(employeeId: string, deviceId: string) {
    setSaving(employeeId);
    setActionError(null);
    try {
      await api(`/sites/${siteId}/postings/${employeeId}`, { method: 'PUT', json: { deviceId: deviceId || null } });
      reload();
    } catch (e) {
      setActionError(e);
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="card">
      <h2>Positions: lock or roam</h2>
      <p className="mute small">
        A guard locked to a position is the main user of that position’s phone whenever he is on duty there. A guard who roams can take the phone over with his PIN, for example to go on patrol; what is done on the phone is recorded
        under whoever is holding it. A locked guard who comes on duty at another position is warned, and the supervisor is told.
      </p>
      <ErrorBanner error={error ?? actionError} />
      {data && data.positions.length === 0 && <p className="mute">This site has no post phones yet. Register one under Devices to make a position.</p>}
      {data && data.guards.length === 0 && <p className="mute">No guards are allocated to this site yet.</p>}
      {data && data.positions.length > 0 && data.guards.length > 0 && (
        <div className="cust-wrap">
          <table className="cust-table">
            <thead>
              <tr>
                <th>Guard</th>
                <th>Position</th>
              </tr>
            </thead>
            <tbody>
              {data.guards.map((g) => (
                <tr key={g.employeeId}>
                  <td>
                    <b>{g.name}</b>
                  </td>
                  <td>
                    <select aria-label={`Position of ${g.name}`} value={g.deviceId ?? ''} disabled={!manage || saving === g.employeeId} onChange={(e) => set(g.employeeId, e.target.value)} style={{ maxWidth: 320 }}>
                      <option value="">Roams</option>
                      {data.positions.map((p) => (
                        <option key={p.deviceId} value={p.deviceId}>
                          Locked to {p.name}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
