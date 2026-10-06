import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'On Par',
  description: 'Measure the work. Manage the performance. Close the loop.',
  icons: { icon: '/tsf-logo.png', apple: '/apple-touch-icon.png' },
  // Lets On Par be added to a phone's home screen and open like an app (needed for alerts on iPhone).
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'On Par', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#18242a' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-ZA">
      <body>{children}</body>
    </html>
  );
}
