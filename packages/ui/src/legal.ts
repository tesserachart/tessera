export const LEGAL_VERSION = '2026-11-04';

export const LEGAL_UPDATED = new Date(`${LEGAL_VERSION}T00:00:00Z`).toLocaleDateString('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

export const SITE_URL = 'https://tesserachart.com';

export const CONTACT_EMAIL = 'beta@tesserachart.com';

export const LEGAL_PAGES = [
  { path: '/terms', title: 'Terms of service' },
  { path: '/privacy', title: 'Privacy policy' },
  { path: '/risk', title: 'Risk disclaimer' },
] as const;
