import { createServer } from 'node:net';

export const DEFAULT_UI_PORT = 5173;

export const UI_HOST = 'localhost';

export interface UiPort {
  port: number;
  strictPort: boolean;
}

export function uiPortConfig(env: NodeJS.ProcessEnv = process.env): UiPort {
  const requested = env.TESSERA_UI_PORT;
  if (requested === undefined || requested === '') return { port: DEFAULT_UI_PORT, strictPort: false };
  const port = Number(requested);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`TESSERA_UI_PORT=${requested} is not a port number`);
  }
  return { port, strictPort: true };
}

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function findFreeUiPort(start = DEFAULT_UI_PORT, host = UI_HOST, attempts = 50): Promise<number> {
  for (let port = start; port < start + attempts && port <= 65_535; port++) {
    if (await canBind(port, host)) return port;
  }
  throw new Error(`no free port for the dev server between ${String(start)} and ${String(start + attempts - 1)}`);
}
