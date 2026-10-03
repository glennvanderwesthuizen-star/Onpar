'use client';

import { useEffect, useState } from 'react';
import { imageUrl } from '@/lib/api';

/** A video or voice note that needs the user's sign-in to load (BOLO). */
export function AuthMedia({ path, kind }: { path: string; kind: 'video' | 'audio' }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let u: string | null = null;
    imageUrl(path)
      .then((x) => setUrl((u = x)))
      .catch((e) => setFailed(e?.message ?? 'Could not load it.'));
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  }, [path]);
  if (failed) return <p className="mute small">{failed}</p>;
  if (!url) return <p className="mute small">Loading…</p>;
  return kind === 'video' ? (
    <video src={url} controls playsInline style={{ width: '100%', maxWidth: 360, borderRadius: 8, display: 'block' }} />
  ) : (
    <audio src={url} controls style={{ width: '100%', maxWidth: 360 }} />
  );
}
