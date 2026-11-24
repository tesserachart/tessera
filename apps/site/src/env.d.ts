/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_UPDATES_URL?: string;
  readonly PUBLIC_PLATFORMS?: string;
  readonly PUBLIC_CLOUD_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
