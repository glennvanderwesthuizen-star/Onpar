'use client';

import { useState } from 'react';
import { useSession } from '@/lib/session';
import { ChangePassword } from '@/components/ChangePassword';

export default function AccountPage() {
  const { me } = useSession();
  const [done, setDone] = useState(false);
  return (
    <>
      <div className="head">
        <div>
          <h1>My account</h1>
          <p className="mute">
            {me.name} · {me.email} · {me.roleLabel}
          </p>
        </div>
      </div>
      <div className="card" style={{ maxWidth: 480 }}>
        <h2>Change password</h2>
        {done ? <div className="banner ok">Your password has been changed.</div> : <ChangePassword email={me.email} onDone={() => setDone(true)} />}
      </div>
    </>
  );
}
