import type { GpuState } from '../types.ts';
import type { GpuSurface, GpuTextureFormat } from '../layers/types.ts';

export interface GpuCanvasLike {
  width: number;
  height: number;
  getContext(type: 'webgl2', attributes?: Record<string, unknown>): unknown;
  addEventListener?(type: string, listener: (e: { preventDefault(): void }) => void): void;
  removeEventListener?(type: string, listener: (e: { preventDefault(): void }) => void): void;
}

export interface GpuHost {
  acquire(): GpuCanvasLike | null;
  release(): void;
}

export const GPU_PIXEL_RATIO = 1;
export const MAX_GPU_CONTEXTS = 4;
export const GPU_TEXTURE_BYTES = 64 * 1024 * 1024;
export const GPU_UPLOAD_BYTES_PER_FRAME = 256 * 1024;
export const GPU_MAX_LOSSES = 2;

let contextsHeld = 0;

export function gpuContextsHeld(): number {
  return contextsHeld;
}

export function parseColor(css: string): [number, number, number, number] {
  const s = css.trim();
  if (s.startsWith('#')) {
    const h = s.slice(1);
    const full = h.length === 3 || h.length === 4 ? h.replace(/./g, '$&$&') : h;
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
    if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(full)) return [n(0), n(2), n(4), full.length === 8 ? n(6) : 1];
  }
  const m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const parts = m[1]!
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length >= 3 && parts.every((v) => Number.isFinite(v))) {
      return [parts[0]! / 255, parts[1]! / 255, parts[2]! / 255, parts[3] ?? 1];
    }
  }
  return [0, 0, 0, 1];
}

interface PooledTexture {
  texture: WebGLTexture;
  width: number;
  height: number;
  format: GpuTextureFormat;
  version: number;
  data: Uint16Array | Uint8Array;
  bytes: number;
}

export class WebGlSurface implements GpuSurface {
  readonly gl: WebGL2RenderingContext;
  width = 1;
  height = 1;
  generation = 0;
  uploadBudget = GPU_UPLOAD_BYTES_PER_FRAME;
  lost = false;
  bytes = 0;
  private readonly pool = new Map<string, PooledTexture>();
  private readonly programs = new Map<string, WebGLProgram>();
  private readonly cap: number;

  constructor(gl: WebGL2RenderingContext, cap = GPU_TEXTURE_BYTES) {
    this.gl = gl;
    this.cap = cap;
  }

  beginFrame(width: number, height: number, background: string): void {
    const gl = this.gl;
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.uploadBudget = GPU_UPLOAD_BYTES_PER_FRAME;
    gl.viewport(0, 0, this.width, this.height);
    const [r, g, b] = parseColor(background);
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  has(key: string, version = 0): boolean {
    return this.pool.get(key)?.version === version;
  }

  texture(
    key: string,
    width: number,
    height: number,
    format: GpuTextureFormat,
    data: Uint16Array | Uint8Array,
    version = 0,
  ): WebGLTexture {
    const held = this.pool.get(key);
    if (held?.version === version && held.width === width && held.height === height && held.format === format) {
      this.setMostRecent(key, held);
      return held.texture;
    }
    const texture = held?.texture ?? this.gl.createTexture();
    const bytes = width * height * (format === 'r16f' ? 2 : 4);
    this.upload(texture, width, height, format, data, !held);
    if (held) this.bytes -= held.bytes;
    this.setMostRecent(key, { texture, width, height, format, version, data, bytes });
    this.bytes += bytes;
    this.uploadBudget -= bytes;
    this.evict(key);
    return texture;
  }

  release(key: string): void {
    const held = this.pool.get(key);
    if (!held) return;
    this.pool.delete(key);
    this.bytes -= held.bytes;
    if (!this.lost) this.gl.deleteTexture(held.texture);
  }

  program(key: string, vertex: string, fragment: string): WebGLProgram {
    const held = this.programs.get(key);
    if (held) return held;
    const gl = this.gl;
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type);
      if (!s) throw new Error('[chart] gpu: no shader');
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s) ?? '';
        gl.deleteShader(s);
        throw new Error(`[chart] gpu: ${key} did not compile: ${log}`);
      }
      return s;
    };
    const vs = shader(gl.VERTEX_SHADER, vertex);
    const fs = shader(gl.FRAGMENT_SHADER, fragment);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? '';
      gl.deleteProgram(program);
      throw new Error(`[chart] gpu: ${key} did not link: ${log}`);
    }
    this.programs.set(key, program);
    return program;
  }

  markLost(): void {
    this.lost = true;
  }

  restore(): void {
    this.lost = false;
    this.generation++;
    this.programs.clear();
    for (const t of this.pool.values()) {
      t.texture = this.gl.createTexture();
      this.upload(t.texture, t.width, t.height, t.format, t.data, true);
    }
  }

  dispose(): void {
    if (!this.lost) {
      for (const t of this.pool.values()) this.gl.deleteTexture(t.texture);
      for (const p of this.programs.values()) this.gl.deleteProgram(p);
    }
    this.pool.clear();
    this.programs.clear();
    this.bytes = 0;
  }

  private upload(
    texture: WebGLTexture,
    width: number,
    height: number,
    format: GpuTextureFormat,
    data: Uint16Array | Uint8Array,
    fresh: boolean,
  ): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (fresh) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    if (format === 'r16f') gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, width, height, 0, gl.RED, gl.HALF_FLOAT, data);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }

  private setMostRecent(key: string, texture: PooledTexture): void {
    this.pool.delete(key);
    this.pool.set(key, texture);
  }

  private evict(keep: string): void {
    for (const [key] of this.pool) {
      if (this.bytes <= this.cap) break;
      if (key !== keep) this.release(key);
    }
  }
}

export class GpuController {
  state: GpuState = 'none';
  private surface: WebGlSurface | null = null;
  private canvas: GpuCanvasLike | null = null;
  private losses = 0;
  private holdsSlot = false;
  private readonly host: GpuHost | null;
  private readonly onChange: () => void;

  constructor(host: GpuHost | null | undefined, onChange: () => void) {
    this.host = host ?? null;
    this.onChange = onChange;
  }

  surfaceFor(want: boolean): WebGlSurface | null {
    if (!want) {
      if (this.state !== 'failed') {
        this.drop();
        this.state = 'none';
      }
      return null;
    }
    if (this.state === 'failed') return null;
    if (this.surface) {
      if (this.surface.lost) {
        this.state = 'fallback';
        return null;
      }
      this.state = 'active';
      return this.surface;
    }
    if (!this.host) {
      this.state = 'failed';
      return null;
    }
    if (contextsHeld >= MAX_GPU_CONTEXTS) {
      this.state = 'fallback';
      return null;
    }
    const canvas = this.host.acquire();
    const gl = canvas?.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null | undefined;
    if (!canvas || !gl) {
      this.host.release();
      this.state = 'failed';
      return null;
    }
    contextsHeld++;
    this.holdsSlot = true;
    this.canvas = canvas;
    this.surface = new WebGlSurface(gl);
    canvas.addEventListener?.('webglcontextlost', this.onLost);
    canvas.addEventListener?.('webglcontextrestored', this.onRestored);
    this.state = 'active';
    return this.surface;
  }

  destroy(): void {
    this.drop();
    this.state = 'none';
  }

  private readonly onLost = (e: { preventDefault(): void }) => {
    // without preventDefault the browser never restores the context
    e.preventDefault();
    this.losses++;
    if (this.losses >= GPU_MAX_LOSSES) {
      this.drop();
      this.state = 'failed';
    } else {
      this.surface?.markLost();
      this.state = 'fallback';
    }
    this.onChange();
  };

  private readonly onRestored = () => {
    if (!this.surface) return;
    this.surface.restore();
    this.state = 'active';
    this.onChange();
  };

  private drop(): void {
    const canvas = this.canvas;
    if (canvas) {
      canvas.removeEventListener?.('webglcontextlost', this.onLost);
      canvas.removeEventListener?.('webglcontextrestored', this.onRestored);
    }
    const surface = this.surface;
    if (surface) {
      surface.dispose();
      // a WebGL context otherwise lives until its canvas is collected
      if (!surface.lost) {
        (surface.gl.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
      }
    }
    if (canvas) this.host?.release();
    if (this.holdsSlot) contextsHeld--;
    this.holdsSlot = false;
    this.surface = null;
    this.canvas = null;
  }
}
