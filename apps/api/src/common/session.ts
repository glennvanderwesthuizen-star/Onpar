import { ForbiddenException } from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * The website's sign-in lives in an httpOnly cookie, so page scripts can never
 * read it. Other clients (tests, integrations) may still send a Bearer token.
 */
export const SESSION_COOKIE = 'onpar_session';
export const SESSION_HOURS = 12;
/** State-changing requests signed in by cookie must carry this header (cross-site forms cannot set it). */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'OnPar';

export function readCookie(req: Request, name: string): string {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

export function setSessionCookie(res: Response, token: string, secure: boolean, hours = SESSION_HOURS) {
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, secure, sameSite: 'strict', path: '/api', maxAge: hours * 3600 * 1000 });
}

export function clearSessionCookie(res: Response, secure: boolean) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure, sameSite: 'strict', path: '/api' });
}

/** The user token from the Authorization header, or else from the cookie (with the CSRF check). */
export function userToken(req: Request): string {
  const header = req.headers.authorization ?? '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  const cookie = readCookie(req, SESSION_COOKIE);
  if (cookie && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers[CSRF_HEADER] !== CSRF_VALUE) {
    throw new ForbiddenException('This request was refused. Reload the page and try again.');
  }
  return cookie;
}
