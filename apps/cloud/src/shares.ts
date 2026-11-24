import { z } from 'zod';

export const MAX_SHARE_BYTES = 12 * 1024 * 1024;
export const MAX_SHARE_IMAGE_BYTES = 8 * 1024 * 1024;

const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID_LENGTH = 12;
const UNBIASED_BYTE_LIMIT = 256 - (256 % ID_ALPHABET.length);
const SHARE_ID = new RegExp(`^[0-9A-Za-z]{${String(ID_LENGTH)}}$`);

export const SHARE_ENTITLEMENT = 'share';

const ImageType = z.enum(['image/png', 'image/jpeg']);
export type ImageType = z.infer<typeof ImageType>;

export const ShareRequest = z.object({
  kind: z.literal('chart'),
  title: z.string().trim().min(1).max(120),
  image: z.object({ type: ImageType, data: z.base64().min(4) }),
  width: z.int().min(1).max(16384),
  height: z.int().min(1).max(16384),
});
export type ShareRequest = z.infer<typeof ShareRequest>;

export interface Share {
  id: string;
  userId: string;
  kind: 'chart';
  title: string;
  imageType: ImageType;
  width: number;
  height: number;
  createdAt: string;
}

export interface StoredImage {
  body: ReadableStream | ArrayBuffer;
  type: string;
}

export interface ShareImages {
  put(id: string, bytes: Uint8Array, type: ImageType): Promise<void>;
  get(id: string): Promise<StoredImage | null>;
  delete(id: string): Promise<void>;
}

export function r2Images(bucket: R2Bucket): ShareImages {
  const key = (id: string) => `shares/${id}`;
  return {
    async put(id, bytes, type) {
      await bucket.put(key(id), bytes, { httpMetadata: { contentType: type } });
    },
    async get(id) {
      const object = await bucket.get(key(id));
      if (object === null) return null;
      return { body: object.body, type: object.httpMetadata?.contentType ?? 'application/octet-stream' };
    },
    async delete(id) {
      await bucket.delete(key(id));
    },
  };
}

export function isShareId(id: string): boolean {
  return SHARE_ID.test(id);
}

export function shareId(): string {
  let id = '';
  while (id.length < ID_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(ID_LENGTH * 2))) {
      if (byte >= UNBIASED_BYTE_LIMIT || id.length === ID_LENGTH) continue;
      id += ID_ALPHABET.charAt(byte % ID_ALPHABET.length);
    }
  }
  return id;
}

export function decoded(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

export function isImageOf(bytes: Uint8Array, type: ImageType): boolean {
  const signature = type === 'image/png' ? PNG_SIGNATURE : JPEG_SIGNATURE;
  return signature.every((b, i) => bytes[i] === b);
}

export function shareUrl(origin: string, id: string): string {
  return `${origin}/s/${id}`;
}
