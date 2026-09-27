'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ErrorBanner, useLoad } from '@/components/ui';

interface Item {
  name: string;
  tracking: 'size' | 'asset';
  active: boolean;
}

export default function KitPage() {
  const { can } = useSession();
  const editable = can('kit.manage');
  const { data, error } = useLoad(() => api<Item[]>('/kit/catalogue'));
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data) setItems(data);
  }, [data]);
  const set = (i: number, patch: Partial<Item>) => {
    setItems(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
    setSaved(false);
  };

  return (
    <>
      <div className="head">
        <div>
          <Link href="/reorders" className="mute small">
            ← Re-orders
          </Link>
          <h1>Kit list</h1>
          <p className="mute">
            The uniform and equipment your company issues. Uniform has sizes; equipment has asset numbers. Used when enrolling officers and for re-orders.
          </p>
        </div>
      </div>
      <ErrorBanner error={error ?? saveError} />
      {saved && <div className="banner ok">Kit list saved.</div>}
      <div className="card scroll">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Tracked by</th>
              <th>In use</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i}>
                <td>
                  <input value={it.name} disabled={!editable} onChange={(e) => set(i, { name: e.target.value })} aria-label="Item name" />
                </td>
                <td>
                  <select value={it.tracking} disabled={!editable} onChange={(e) => set(i, { tracking: e.target.value as Item['tracking'] })} aria-label="Tracked by">
                    <option value="size">Size</option>
                    <option value="asset">Asset number</option>
                  </select>
                </td>
                <td>
                  <input type="checkbox" checked={it.active} disabled={!editable} onChange={(e) => set(i, { active: e.target.checked })} aria-label={`${it.name} in use`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {editable && (
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn ghost" onClick={() => setItems([...items, { name: '', tracking: 'size', active: true }])}>
              + Add item
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setSaveError(null);
                try {
                  setItems(await api<Item[]>('/kit/catalogue', { method: 'PUT', json: { items: items.filter((x) => x.name.trim()) } }));
                  setSaved(true);
                } catch (e) {
                  setSaveError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save kit list
            </button>
          </div>
        )}
        {!editable && <p className="mute small">Only a company manager or administrator can change the kit list.</p>}
      </div>
    </>
  );
}
