const PRIVATE = '[data-private]';

const DIGIT = /\d/g;
const VISIBLE = /\S/g;

const TEXT_ATTRIBUTES = new Set([
  'aria-label',
  'aria-valuetext',
  'aria-valuenow',
  'aria-valuemin',
  'aria-valuemax',
  'aria-description',
  'aria-placeholder',
  'title',
  'alt',
  'placeholder',
  'value',
  'label',
  'content',
]);

function inPrivate(element: Element | null | undefined): boolean {
  return (element?.closest(PRIVATE) ?? null) !== null;
}

export function maskText(text: string, element?: Element | null): string {
  return inPrivate(element) ? text.replace(VISIBLE, '*') : text.replace(DIGIT, '*');
}

export function maskAttribute(name: string, value: string, element?: Element): string {
  if (TEXT_ATTRIBUTES.has(name)) return maskText(value, element);
  if (name.startsWith('data-')) return value.replace(DIGIT, '*');
  return value;
}

export function maskInput(text: string): string {
  return '*'.repeat(text.length);
}
