'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { emptyTask, TaskForm } from '@/components/TaskForm';

export default function NewTaskPage() {
  const router = useRouter();
  return (
    <>
      <div className="head">
        <div>
          <Link href="/tasks" className="mute small">
            ← Tasks
          </Link>
          <h1>New task</h1>
        </div>
      </div>
      <TaskForm
        initial={emptyTask()}
        onSave={async (t) => {
          await api('/tasks', { method: 'POST', json: t });
          router.push('/tasks');
        }}
      />
    </>
  );
}
