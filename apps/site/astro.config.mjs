import sitemap from '@astrojs/sitemap';
import { defineConfig, fontProviders } from 'astro/config';

const site = process.env.SITE_URL ?? 'https://tesserachart.com';

const unlisted = new Set(['/404']);

export default defineConfig({
  site,
  output: 'static',
  trailingSlash: 'never',
  build: { format: 'file', inlineStylesheets: 'auto' },
  integrations: [sitemap({ filter: (page) => !unlisted.has(new URL(page).pathname.replace(/\/$/, '')) })],
  image: { responsiveStyles: false },
  fonts: [
    {
      provider: fontProviders.local(),
      name: 'Instrument Serif',
      cssVariable: '--font-serif',
      fallbacks: ['Times New Roman', 'serif'],
      display: 'swap',
      options: {
        variants: [
          { src: ['@tessera/ui/fonts/InstrumentSerif-Regular.woff2'], weight: 400, style: 'normal' },
          { src: ['@tessera/ui/fonts/InstrumentSerif-Italic.woff2'], weight: 400, style: 'italic' },
        ],
      },
    },
    {
      provider: fontProviders.local(),
      name: 'Instrument Sans',
      cssVariable: '--font-sans',
      fallbacks: ['Arial', 'sans-serif'],
      display: 'swap',
      options: {
        variants: [{ src: ['@tessera/ui/fonts/InstrumentSans-VF.woff2'], weight: '400 700', style: 'normal' }],
      },
    },
  ],
  devToolbar: { enabled: false },
});
