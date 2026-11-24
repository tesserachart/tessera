import type { Bridge } from '@tessera/bridge';
import type { RuntimeClient } from '@tessera/protocol';
import { createStore } from 'zustand/vanilla';

export interface AppServices {
  readonly host: Bridge;
  readonly client: RuntimeClient;
}

export const servicesStore = createStore<AppServices | null>(() => null);

export function provideServices(services: AppServices | null): void {
  if (servicesStore.getState() === services) return;
  servicesStore.setState(services, true);
}

function appServicesNow(): AppServices {
  const services = servicesStore.getState();
  if (!services) throw new Error('the app services were read before RuntimeProvider provided them');
  return services;
}

export function appClient(): RuntimeClient {
  return appServicesNow().client;
}

export function appHost(): Bridge {
  return appServicesNow().host;
}
