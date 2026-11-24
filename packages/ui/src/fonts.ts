export const BRAND_FACES = [
  '400 16px "Instrument Serif"',
  '400 16px "Instrument Sans"',
  '500 16px "Instrument Sans"',
  '600 16px "Instrument Sans"',
  '400 16px "Tessera Figures"',
] as const;

export async function brandFontsReady(fonts: Pick<FontFaceSet, 'load'> | null, waitMs: number): Promise<boolean> {
  if (!fonts) return false;
  const loaded = Promise.all(BRAND_FACES.map((face) => fonts.load(face))).then(
    () => true,
    () => false,
  );
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), waitMs));
  return Promise.race([loaded, timeout]);
}
