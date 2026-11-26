import { encodeOn, type Encoded, type EncodeJob } from './encode.ts';

interface WorkerScope {
  onmessage: ((e: MessageEvent<EncodeJob>) => void) | null;
  postMessage(message: Encoded | { failed: string }): void;
}

const scope = globalThis as unknown as WorkerScope;

scope.onmessage = (e) => {
  const { bitmap } = e.data;
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    scope.postMessage({ failed: 'no canvas to encode on' });
    return;
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  encodeOn(canvas, (w, h) => new OffscreenCanvas(w, h)).then(
    (done) => scope.postMessage(done),
    (err: unknown) => scope.postMessage({ failed: err instanceof Error ? err.message : String(err) }),
  );
};
