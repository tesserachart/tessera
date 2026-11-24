import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { WINDOW_TILE_PARAM } from '../../packages/bridge/src/types.ts';
import { SPLASH_MARK_CLASS, splashMarkSvg } from '../../packages/ui/src/components/splashMark.ts';
import { tesseraRuntime } from './dev/runtime-plugin.ts';
import { UI_HOST, uiPortConfig } from './dev/ui-port.ts';

const repoRoot = resolve(import.meta.dirname, '../..');
const version = (
  JSON.parse(readFileSync(resolve(import.meta.dirname, 'src-tauri/tauri.conf.json'), 'utf8')) as { version: string }
).version;
const commit = buildCommit();
const { port, strictPort } = uiPortConfig();

function buildCommit(): string | null {
  const ci = process.env.GITHUB_SHA?.trim();
  if (ci) return ci.slice(0, 7);
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

const INTRO_SESSION_KEY = 'tessera.intro';

function introOncePerSession(): string {
  const key = JSON.stringify(INTRO_SESSION_KEY);
  const tile = JSON.stringify(WINDOW_TILE_PARAM);
  return (
    '(() => {' +
    'const root = document.documentElement;' +
    `if (new URLSearchParams(location.search).has(${tile})) root.dataset.intro = 'played';` +
    `try { if (sessionStorage.getItem(${key})) root.dataset.intro = 'played'; sessionStorage.setItem(${key}, 'played'); } catch {}` +
    '})();'
  );
}

function bootSplash(): Plugin {
  return {
    name: 'tessera-boot-splash',
    transformIndexHtml(html) {
      const wordmark = readFileSync(resolve(repoRoot, 'packages/ui/brand/wordmark.svg')).toString('base64');
      const boot =
        `<script>${introOncePerSession()}</script>` +
        '<div id="boot" class="t-splash t-sh-splash" aria-hidden="true"><div class="lock">' +
        `<i class="${SPLASH_MARK_CLASS}">${splashMarkSvg()}</i>` +
        `<img class="wm" src="data:image/svg+xml;base64,${wordmark}" alt="" />` +
        '<div class="say">&nbsp;</div></div></div>';
      return html.replace('<!--boot-->', boot);
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), react(), bootSplash(), tesseraRuntime(repoRoot)],
  clearScreen: false,
  server: {
    host: UI_HOST,
    port,
    strictPort,
  },
  preview: { host: UI_HOST, port: port + 1, strictPort },
  define: {
    'import.meta.env.TESSERA_VERSION': JSON.stringify(version),
    'import.meta.env.TESSERA_COMMIT': JSON.stringify(commit),
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
});
