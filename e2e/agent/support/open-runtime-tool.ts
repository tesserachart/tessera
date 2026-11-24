import { surfaceOf } from '@e2e-dev/web';
import { jsonSchema, tool } from 'ai';
import { defineTool } from 'e2e/agent';
import { nextLaunchTicket } from './launch.ts';

type EngineHandle = Parameters<typeof surfaceOf>[0];

export function openRuntimeTool(engine: EngineHandle) {
  return defineTool(
    tool({
      description:
        "Open the Tessera runtime's launch link so this page holds its session token. Call it only when the page " +
        'shows the connection screen ("Open the runtime\'s URL" or "Session ended"); the app then connects.',
      inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {}, additionalProperties: false }),
      execute: async () => {
        const page = surfaceOf(engine)?.page();
        if (!page) throw new Error('no open page');
        const { origin, ticket } = await nextLaunchTicket(new URL(page.url()).origin);
        await page.goto(`${origin}/#ticket=${encodeURIComponent(ticket)}`);
        await page.waitForURL(`${origin}/`);
        return "Opened the runtime's launch link: the page is let in and keeps the token in memory.";
      },
    }),
    { mutates: true, platforms: ['web'] },
  );
}
