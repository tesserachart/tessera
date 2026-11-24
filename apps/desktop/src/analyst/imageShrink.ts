import {
  MAX_IMAGE_BYTES,
  MAX_SOURCE_IMAGE_BYTES,
  QUALITY_STEPS,
  SCALE_STEPS,
  fitWithin,
  imageType,
  jpegName,
} from './attachments.ts';

export type ShrinkResult = { ok: true; file: File } | { ok: false; reason: 'too-large' | 'unreadable' };

async function decode(file: File): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(file);
  } catch {
    return null;
  }
}

function encode(bitmap: ImageBitmap, width: number, height: number, quality: number): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

export async function shrinkImage(file: File): Promise<ShrinkResult> {
  const type = imageType(file);
  if (type && file.size <= MAX_IMAGE_BYTES) {
    return { ok: true, file: type === file.type ? file : new File([file], file.name, { type }) };
  }
  if (file.size > MAX_SOURCE_IMAGE_BYTES) return { ok: false, reason: 'too-large' };
  if (typeof createImageBitmap !== 'function') return { ok: false, reason: 'unreadable' };
  const bitmap = await decode(file);
  if (!bitmap) return { ok: false, reason: 'unreadable' };
  try {
    const fit = fitWithin(bitmap.width, bitmap.height);
    for (const scale of [1, ...SCALE_STEPS]) {
      const width = Math.max(1, Math.round(fit.width * scale));
      const height = Math.max(1, Math.round(fit.height * scale));
      for (const quality of QUALITY_STEPS) {
        const blob = await encode(bitmap, width, height, quality);
        if (!blob) return { ok: false, reason: 'unreadable' };
        if (blob.size <= MAX_IMAGE_BYTES)
          return { ok: true, file: new File([blob], jpegName(file.name), { type: 'image/jpeg' }) };
      }
    }
    return { ok: false, reason: 'too-large' };
  } finally {
    bitmap.close();
  }
}
