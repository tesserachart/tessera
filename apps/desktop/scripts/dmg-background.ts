import { readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { chromium, type Browser } from 'playwright';
import { PNG } from 'pngjs';

const repo = resolve(import.meta.dirname, '../../..');
const dir = join(repo, 'apps/desktop/src-tauri/dmg');
const svg = 'apps/desktop/src-tauri/dmg/background.svg';
const [, width, height] = /viewBox="0 0 (\d+) (\d+)"/.exec(readFileSync(join(repo, svg), 'utf8'))!.map(Number);
const contentTypes: Record<string, string> = { '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

async function render(browser: Browser, scale: number): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width: width!, height: height! }, deviceScaleFactor: scale });
  await page.route('http://dmg.local/**', (route) => {
    const path = join(repo, new URL(route.request().url()).pathname);
    return route.fulfill({ body: readFileSync(path), contentType: contentTypes[extname(path)] });
  });
  await page.goto(`http://dmg.local/${svg}`);
  const fontLoaded = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].some((f) => f.family.includes('Instrument Sans') && f.status === 'loaded');
  });
  if (!fontLoaded) throw new Error('Instrument Sans did not load');
  return await page.screenshot({ type: 'png' });
}

const SHORT = 3;
const LONG = 4;
const RATIONAL = 5;
const Tag = {
  ImageWidth: 256,
  ImageLength: 257,
  BitsPerSample: 258,
  Compression: 259,
  PhotometricInterpretation: 262,
  StripOffsets: 273,
  SamplesPerPixel: 277,
  RowsPerStrip: 278,
  StripByteCounts: 279,
  XResolution: 282,
  YResolution: 283,
  PlanarConfiguration: 284,
  ResolutionUnit: 296,
};
const DEFLATE = 8;
const RGB = 2;
const CHUNKY = 1;
const INCH = 2;

// Finder draws a .dmg background at 2x on a Retina screen only from a TIFF that holds both sizes,
// 1x at 72 dpi then 2x at 144 dpi, the file `tiffutil -cathidpicheck` writes.
function hidpiTiff(images: { png: Buffer; dpi: number }[]): Buffer {
  const parts: Buffer[] = [];
  let size = 0;
  const append = (part: Buffer) => {
    parts.push(part);
    size += part.length;
    return size - part.length;
  };
  const header = Buffer.from([0x49, 0x49, 42, 0, 0, 0, 0, 0]);
  append(header);
  let nextDirectoryField = { in: header, at: 4 };
  for (const { png, dpi } of images) {
    const { width: w, height: h, data } = PNG.sync.read(png);
    const rgb = Buffer.alloc(w * h * 3);
    for (let i = 0, o = 0; i < data.length; i += 4, o += 3) data.copy(rgb, o, i, i + 3);
    const strip = deflateSync(rgb, { level: 9 });
    const stripAt = append(strip);
    if (size % 2) append(Buffer.alloc(1));
    const values = Buffer.alloc(22);
    for (const at of [0, 2, 4]) values.writeUInt16LE(8, at);
    for (const at of [6, 14]) values.writeUInt32LE(dpi, at);
    for (const at of [10, 18]) values.writeUInt32LE(1, at);
    const valuesAt = append(values);
    const entries: [tag: number, type: number, count: number, value: number][] = [
      [Tag.ImageWidth, LONG, 1, w],
      [Tag.ImageLength, LONG, 1, h],
      [Tag.BitsPerSample, SHORT, 3, valuesAt],
      [Tag.Compression, SHORT, 1, DEFLATE],
      [Tag.PhotometricInterpretation, SHORT, 1, RGB],
      [Tag.StripOffsets, LONG, 1, stripAt],
      [Tag.SamplesPerPixel, SHORT, 1, 3],
      [Tag.RowsPerStrip, LONG, 1, h],
      [Tag.StripByteCounts, LONG, 1, strip.length],
      [Tag.XResolution, RATIONAL, 1, valuesAt + 6],
      [Tag.YResolution, RATIONAL, 1, valuesAt + 14],
      [Tag.PlanarConfiguration, SHORT, 1, CHUNKY],
      [Tag.ResolutionUnit, SHORT, 1, INCH],
    ];
    const directory = Buffer.alloc(2 + entries.length * 12 + 4);
    directory.writeUInt16LE(entries.length, 0);
    entries.forEach(([tag, type, count, value], i) => {
      const at = 2 + i * 12;
      directory.writeUInt16LE(tag, at);
      directory.writeUInt16LE(type, at + 2);
      directory.writeUInt32LE(count, at + 4);
      if (type === SHORT && count === 1) directory.writeUInt16LE(value, at + 8);
      else directory.writeUInt32LE(value, at + 8);
    });
    nextDirectoryField.in.writeUInt32LE(append(directory), nextDirectoryField.at);
    nextDirectoryField = { in: directory, at: directory.length - 4 };
  }
  return Buffer.concat(parts);
}

const browser = await chromium.launch();
const [one, two] = await Promise.all([render(browser, 1), render(browser, 2)]).finally(() => browser.close());
writeFileSync(join(dir, 'background.png'), one);
writeFileSync(join(dir, 'background@2x.png'), two);
writeFileSync(
  join(dir, 'background.tiff'),
  hidpiTiff([
    { png: one, dpi: 72 },
    { png: two, dpi: 144 },
  ]),
);
console.info(
  `wrote background.png (${String(width)}x${String(height)}), background@2x.png and background.tiff to ${dir}`,
);
