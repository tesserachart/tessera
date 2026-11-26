import { z } from 'zod';

import { decodedBytes } from './feedback.ts';

export const MAX_SHARE_BYTES = 12 * 1024 * 1024;
const MAX_SHARE_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_CONVERSATION_BYTES = 1024 * 1024;
const MAX_SETUP_BYTES = 512 * 1024;

const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID_LENGTH = 12;
const UNBIASED_BYTE_LIMIT = 256 - (256 % ID_ALPHABET.length);
const SHARE_ID = new RegExp(`^[0-9A-Za-z]{${String(ID_LENGTH)}}$`);

export const SHARE_ENTITLEMENT = 'share';

const SETUP_KINDS = ['indicator', 'template', 'layout'] as const;
export type SetupKind = (typeof SETUP_KINDS)[number];
export type ShareKind = 'chart' | 'conversation' | SetupKind;

const ImageType = z.enum(['image/png', 'image/jpeg']);
export type ImageType = z.infer<typeof ImageType>;
const JSON_BODY = 'application/json';
export type BodyType = ImageType | typeof JSON_BODY;

const Title = z.string().trim().min(1).max(120);
const words = (max: number) => z.string().max(max);

const SharedWork = z.object({
  ns: words(40),
  label: words(200),
  meta: words(80).nullable(),
  failed: z.boolean(),
});
export type SharedWork = z.infer<typeof SharedWork>;

const EPISTEMIC_KINDS = ['measured', 'observed', 'hypothesis', 'interpretation'] as const;

const SharedBlock = z.object({
  kind: z.enum(EPISTEMIC_KINDS),
  title: words(200).nullable(),
  text: words(20_000),
  rows: z.array(z.tuple([words(200), words(200)])).max(100),
});
export type SharedBlock = z.infer<typeof SharedBlock>;

const SharedTurn = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), text: words(20_000), files: z.int().min(0) }),
  z.object({
    role: z.literal('analyst'),
    work: z.array(SharedWork).max(300),
    workedMs: z.number().min(0).nullable(),
    answer: words(60_000),
    blocks: z.array(SharedBlock).max(40),
  }),
]);
export type SharedTurn = z.infer<typeof SharedTurn>;

const SharedConversation = z.object({
  v: z.literal(1),
  title: z.string(),
  amounts: z.boolean(),
  turns: z.array(SharedTurn).max(400),
});
export type SharedConversation = z.infer<typeof SharedConversation>;

const SetupLine = z.object({ label: words(80), value: words(200) });
export type SetupLine = z.infer<typeof SetupLine>;

const SetupDisplay = z.object({
  name: words(120),
  about: words(200),
  lines: z.array(SetupLine).max(100),
  parts: z.array(z.object({ name: words(120), lines: z.array(SetupLine).max(100) })).max(64),
  code: z.array(z.object({ name: words(120), code: words(100_000) })).max(8),
});
type SetupDisplay = z.infer<typeof SetupDisplay>;

const ChartRequest = z.object({
  kind: z.literal('chart'),
  title: Title,
  image: z.object({ type: ImageType, data: z.base64().min(4) }),
  width: z.int().min(1).max(16384),
  height: z.int().min(1).max(16384),
});

const ConversationRequest = z.object({
  kind: z.literal('conversation'),
  title: Title,
  conversation: SharedConversation,
});

function setupRequest<K extends SetupKind>(kind: K) {
  return z.object({
    kind: z.literal(kind),
    title: Title,
    display: SetupDisplay,
    setup: z.looseObject({ kind: z.literal(kind) }),
  });
}

export const ShareRequest = z.discriminatedUnion('kind', [
  ChartRequest,
  ConversationRequest,
  setupRequest('indicator'),
  setupRequest('template'),
  setupRequest('layout'),
]);
export type ShareRequest = z.infer<typeof ShareRequest>;

export const ConversationDocument = z.object({ conversation: SharedConversation });
export const SetupDocument = z.object({ display: SetupDisplay, setup: z.looseObject({ kind: z.enum(SETUP_KINDS) }) });
export type SetupDocument = z.infer<typeof SetupDocument>;

interface Shared {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
}

type DocumentKind = Exclude<ShareKind, 'chart'>;
export type ChartShare = Shared & { kind: 'chart'; bodyType: ImageType; width: number; height: number };
export type DocumentShare = { [K in DocumentKind]: Shared & { kind: K; bodyType: typeof JSON_BODY } }[DocumentKind];
export type ConversationShare = Extract<DocumentShare, { kind: 'conversation' }>;
export type SetupShare = Extract<DocumentShare, { kind: SetupKind }>;
export type Share = ChartShare | DocumentShare;

export interface ShareBody {
  bytes: Uint8Array;
  type: BodyType;
}

export type Refusal = 'too_large' | 'bad_request';

export function bodyOf(request: ShareRequest): ShareBody | Refusal {
  switch (request.kind) {
    case 'chart': {
      if (decodedBytes(request.image.data) > MAX_SHARE_IMAGE_BYTES) return 'too_large';
      const bytes = decoded(request.image.data);
      return isImageOf(bytes, request.image.type) ? { bytes, type: request.image.type } : 'bad_request';
    }
    case 'conversation':
      return jsonBody({ conversation: request.conversation }, MAX_CONVERSATION_BYTES);
    case 'indicator':
    case 'template':
    case 'layout':
      return jsonBody({ display: request.display, setup: request.setup }, MAX_SETUP_BYTES);
  }
}

function jsonBody(document: object, max: number): ShareBody | Refusal {
  const bytes = new TextEncoder().encode(JSON.stringify(document));
  return bytes.byteLength > max ? 'too_large' : { bytes, type: JSON_BODY };
}

export function newShare(request: ShareRequest, shared: Shared): Share {
  if (request.kind === 'chart') {
    const { image, width, height } = request;
    return { ...shared, kind: 'chart', bodyType: image.type, width, height };
  }
  return { ...shared, kind: request.kind, bodyType: JSON_BODY };
}

export interface StoredBody {
  body: ReadableStream | ArrayBuffer;
  type: string;
}

export interface ShareBodies {
  put(id: string, bytes: Uint8Array, type: BodyType): Promise<void>;
  get(id: string): Promise<StoredBody | null>;
  delete(id: string): Promise<void>;
}

export function r2Bodies(bucket: R2Bucket): ShareBodies {
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

export async function documentOf<T>(stored: StoredBody, schema: z.ZodType<T>): Promise<T | null> {
  const parsed = schema.safeParse(await new Response(stored.body).json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

export function isShareId(id: string): boolean {
  return SHARE_ID.test(id);
}

export function isSetupKind(kind: ShareKind): kind is SetupKind {
  return (SETUP_KINDS as readonly string[]).includes(kind);
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

function decoded(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

function isImageOf(bytes: Uint8Array, type: ImageType): boolean {
  const signature = type === 'image/png' ? PNG_SIGNATURE : JPEG_SIGNATURE;
  return signature.every((b, i) => bytes[i] === b);
}

export function shareUrl(origin: string, id: string): string {
  return `${origin}/s/${id}`;
}
