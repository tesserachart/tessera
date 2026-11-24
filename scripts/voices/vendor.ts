export interface Quota {
  plan: string;
  used: number;
  limit: number;
  resetsAt: Date | null;
}

export interface SpeakRequest {
  text: string;
  voiceId: string;
  model: string;
  settings: Readonly<Record<string, number | boolean>>;
  seed: number;
  /** ISO 639-1; a lone word is otherwise read in whatever language the model guesses. */
  language: string;
}

export interface Speech {
  audio: Uint8Array;
  ext: 'mp3' | 'wav' | 'ogg';
  charged: number | null;
  requestId: string | null;
}

export interface TtsVendor {
  readonly id: string;
  readonly credit: string;
  quota(): Promise<Quota>;
  costOf(text: string, model: string): Promise<number>;
  speak(req: SpeakRequest): Promise<Speech>;
}
