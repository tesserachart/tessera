import { QueryClient, type Query } from '@tanstack/react-query';
import { connectionEpoch } from './connection.ts';
import { onMarketServed } from './health.ts';
import { servicesStore } from './services.ts';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      gcTime: 30_000,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});

export const TOOL_READS = 'tool';
export const TOOL_LIST = 'tools';

connectionEpoch.subscribe((epoch, previous) => {
  if (epoch === null || previous === null) return;
  void queryClient.invalidateQueries({ queryKey: [TOOL_LIST] });
  void queryClient.invalidateQueries({ queryKey: [TOOL_READS] });
});

const refusedReads = { queryKey: [TOOL_READS], predicate: (q: Query) => q.state.status === 'error' };
let askAgainOnServed: (() => void) | null = null;

queryClient.getQueryCache().subscribe(() => {
  const waiting = queryClient.getQueryCache().findAll(refusedReads).length > 0;
  if (waiting && !askAgainOnServed) {
    askAgainOnServed = onMarketServed(() => void queryClient.invalidateQueries(refusedReads));
  } else if (!waiting && askAgainOnServed) {
    askAgainOnServed();
    askAgainOnServed = null;
  }
});

servicesStore.subscribe(() => {
  void queryClient.resetQueries();
});
