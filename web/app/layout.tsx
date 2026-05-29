import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { OtelInit } from '@/components/OtelInit';
import './globals.css';

export const metadata: Metadata = {
  title: 'Dispatch — weekly newsletter review',
  description: 'Review, edit, and approve the weekly all-hands newsletter.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <OtelInit />
        {children}
      </body>
    </html>
  );
}
