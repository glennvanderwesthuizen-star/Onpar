/** @type {import('next').NextConfig} */
const API = process.env.API_URL ?? 'http://localhost:4000';
export default {
  transpilePackages: ['@onpar/rules'],
  // The browser talks to /api on the same origin; Next forwards it to the API server.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API}/api/:path*` }];
  },
};
