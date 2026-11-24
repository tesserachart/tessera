import { makeStore } from '../app/store.ts';

export const arrivalStore = makeStore({ shown: false, onboarding: false, arrived: false });
