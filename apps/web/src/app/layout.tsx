import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'On Par',
  description: 'Measure the work. Manage the performance. Close the loop.',
  icons: { icon: '/tsf-logo.png' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-ZA">
      <body>{children}</body>
    </html>
  );
}
