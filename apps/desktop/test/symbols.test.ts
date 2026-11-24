import { describe, expect, it } from 'vitest';
import { runtimeSymbolFiles } from '../scripts/symbols.ts';

describe('the runtime symbols a release uploads to PostHog', () => {
  it('are the dSYM on macOS, the executable with its debug info on Linux, and none on Windows', () => {
    expect(runtimeSymbolFiles('/t/release/tessera-runtime', 'darwin')).toEqual(['/t/release/tessera-runtime.dSYM']);
    expect(runtimeSymbolFiles('/t/release/tessera-runtime', 'linux')).toEqual(['/t/release/tessera-runtime']);
    expect(runtimeSymbolFiles('C:/t/release/tessera-runtime.exe', 'win32')).toBeNull();
  });
});
