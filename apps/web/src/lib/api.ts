const TOKEN_KEY = 'onpar.token';

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: the session lasts until reload */
  }
}

/** An error from the API, with per-field messages and site-fit warnings when present. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public errors: Record<string, string> = {},
    public warnings: string[] = [],
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.json);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { ...init, headers, body });
  } catch {
    throw new ApiError(0, 'Could not reach the server. Check your connection and try again.');
  }
  if (res.status === 401 && path !== '/auth/login') {
    setToken(null);
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const message = Array.isArray(data?.message) ? data.message.join(' ') : data?.message ?? `Something went wrong (${res.status}).`;
    throw new ApiError(res.status, message, data?.errors ?? {}, data?.warnings ?? []);
  }
  return data as T;
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

/** Fetches an authenticated image and returns an object URL for an <img>. */
export async function imageUrl(path: string): Promise<string> {
  const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new ApiError(res.status, 'Could not load the photo.');
  return URL.createObjectURL(await res.blob());
}

/** Opens an authenticated file (for example a certificate PDF) in a new tab. */
export async function openFile(path: string) {
  const tab = window.open('', '_blank');
  try {
    const url = await imageUrl(path);
    if (tab) tab.location.href = url;
    else window.location.href = url;
  } catch {
    tab?.close();
    alert('Could not open the file.');
  }
}
