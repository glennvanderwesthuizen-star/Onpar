'use client';

import { useEffect, useState } from 'react';
import { imageUrl } from '@/lib/api';

/** A photo that needs the user's sign-in to load (BOLO and report photos). */
export function AuthPhoto({ path, alt, width = 220 }: { path: string; alt: string; width?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let u: string | null = null;
    imageUrl(path)
      .then((x) => setUrl((u = x)))
      .catch(() => setFailed(true));
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  }, [path]);
  if (failed) return <p className="mute small">Could not load the photo.</p>;
  return url ? (
    <a href={url} target="_blank" rel="noreferrer">
      <img src={url} alt={alt} style={{ maxWidth: width, borderRadius: 8, display: 'block' }} />
    </a>
  ) : (
    <p className="mute small">Loading photo…</p>
  );
}
