'use client';

import { useEffect } from 'react';
import { startBrowserOtel } from '@/lib/otel-browser';

export function OtelInit(): null {
  useEffect(() => {
    startBrowserOtel();
  }, []);
  return null;
}
