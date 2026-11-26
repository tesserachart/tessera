const MAX_PNG_BYTES = 5 * 1024 * 1024;

const JPEG_QUALITY = 0.85;

const PREVIEW_WIDTH = 960;

export interface EncodeJob {
  bitmap: ImageBitmap;
}

export interface Encoded {
  full: Blob;
  preview: Blob;
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

function blobFrom(canvas: AnyCanvas, type: string, quality?: number): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('the picture could not be encoded'))),
      type,
      quality,
    );
  });
}

export async function encodeOn<C extends AnyCanvas>(canvas: C, make: (w: number, h: number) => C): Promise<Encoded> {
  let full = await blobFrom(canvas, 'image/png');
  if (full.size > MAX_PNG_BYTES) full = await blobFrom(canvas, 'image/jpeg', JPEG_QUALITY);
  let small: AnyCanvas = canvas;
  if (canvas.width > PREVIEW_WIDTH) {
    const out = make(PREVIEW_WIDTH, Math.max(1, Math.round((canvas.height * PREVIEW_WIDTH) / canvas.width)));
    const ctx = out.getContext('2d');
    if (ctx) {
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(canvas, 0, 0, out.width, out.height);
      small = out;
    }
  }
  return { full, preview: await blobFrom(small, 'image/jpeg', JPEG_QUALITY) };
}

function inWorker(canvas: HTMLCanvasElement): Promise<Encoded> {
  return createImageBitmap(canvas).then(
    (bitmap) =>
      new Promise<Encoded>((resolve, reject) => {
        const worker = new Worker(new URL('./encode.worker.ts', import.meta.url), { type: 'module' });
        const done = () => worker.terminate();
        worker.onmessage = (e: MessageEvent<Encoded | { failed: string }>) => {
          done();
          if ('failed' in e.data) reject(new Error(e.data.failed));
          else resolve(e.data);
        };
        worker.onerror = (e) => {
          done();
          reject(new Error(e.message || 'the picture could not be encoded'));
        };
        const job: EncodeJob = { bitmap };
        worker.postMessage(job, [bitmap]);
      }),
  );
}

export function encodePicture(canvas: HTMLCanvasElement): Promise<Encoded> {
  const onPage = () =>
    encodeOn(canvas, (w, h) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    });
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return onPage();
  return inWorker(canvas).catch((e: unknown) => {
    console.warn('[feedback] the picture is encoded on the page instead', e);
    return onPage();
  });
}
