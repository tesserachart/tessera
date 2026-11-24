import { QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { queryClient } from './queries.ts';
import { provideServices, type AppServices } from './services.ts';

export function RuntimeProvider({ services, children }: { services: AppServices; children: ReactNode }) {
  useState(() => {
    provideServices(services);
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
