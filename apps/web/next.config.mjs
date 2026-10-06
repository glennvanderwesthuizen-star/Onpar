/** @type {import('next').NextConfig} */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const API = process.env.API_URL ?? 'http://localhost:4000';
const dev = process.env.NODE_ENV !== 'production';

// Next.js needs inline scripts and styles; everything else comes only from this site.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "connect-src 'self'",
  "font-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export default {
  transpilePackages: ['@onpar/rules'],
  // A self-contained build for the server package (deploy/Dockerfile).
  output: 'standalone',
  outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), '..', '..'),
  poweredByHeader: false,
  // The browser talks to /api on the same origin; Next forwards it to the API server.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API}/api/:path*` }];
  },
  async headers() {
    return [
      // The alert receiver must always be the current version, never an old copy kept by the browser.
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          // Location only for "use my current location" when setting up patrol points.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self), payment=()' },
          ...(dev ? [] : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]),
        ],
      },
    ];
  },
};
