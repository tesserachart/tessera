import type { ShareImageInput } from '@tessera/protocol';
import { blobOf } from '../feedback/capture.ts';

const PNG = 'image/png';

function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function asPng(picture: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(picture);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('the picture could not be drawn');
    ctx.drawImage(bitmap, 0, 0);
    return await blobOf(canvas, PNG);
  } finally {
    bitmap.close();
  }
}

function pngOf(image: Pick<ShareImageInput, 'type' | 'data'>): Promise<Blob> {
  const picture = new Blob([bytesOf(image.data)], { type: image.type });
  return image.type === PNG ? Promise.resolve(picture) : asPng(picture);
}

export function copyPicture(image: Pick<ShareImageInput, 'type' | 'data'>): Promise<void> {
  return navigator.clipboard.write([new ClipboardItem({ [PNG]: pngOf(image) })]);
}
