'use client';

import Link from 'next/link';
import { use } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { TaskForm, TaskValue } from '@/components/TaskForm';
import { ErrorBanner, useLoad } from '@/components/ui';

export default function EditTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data, error } = useLoad(async () => {
    const all = await api<(TaskValue & { id: string; active: boolean })[]>('/tasks');
    const t = all.find((x) => x.id === id);
    if (!t) throw new Error('Task not found.');
    return t;
  }, [id]);

  if (error) return <ErrorBanner error={error} />;
  if (!data) return <p className="mute">Loading…</p>;
  return (
    <>
      <div className="head">
        <div>
          <Link href="/tasks" className="mute small">
            ← Tasks
          </Link>
          <h1>Edit task</h1>
          <p className="mute">Changes apply to today&apos;s and later occurrences that are not done yet. Past records stay as they were.</p>
        </div>
      </div>
      <TaskForm
        editing
        initial={data}
        onSave={async (t) => {
          await api(`/tasks/${id}`, { method: 'PUT', json: t });
          router.push('/tasks');
        }}
      />
    </>
  );
}
