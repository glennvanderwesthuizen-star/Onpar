import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'On Par: my messages' };

/** The employee portal (brief section 6.14): the guard's personal door, on his own phone. */
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return <div className="m-shell">{children}</div>;
}
