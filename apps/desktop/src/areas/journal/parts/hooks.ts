import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useHasTool, useToolValue } from '../../../app/tools.ts';

export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function useAttachmentUrl(id: string | null): string | null {
  const has = useHasTool('journal.get_attachment');
  const q = useToolValue('journal.get_attachment', has && !!id ? { id: id } : null, { keepFor: Infinity });
  const data = q;
  const url = useMemo(() => {
    if (!data) return null;
    const bin = atob(data.dataBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: data.info.mediaType }));
  }, [data]);
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  return url;
}

export function fileBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = typeof r.result === 'string' ? r.result : '';
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.onerror = () => reject(r.error ?? new Error('could not read the file'));
    r.readAsDataURL(f);
  });
}

export function useSplitWidth(key: string, initial: number, min: number, max: number) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  const [width, setWidth] = useState(() => {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v >= min && v <= max ? v : initial;
  });
  const start = useRef(width);
  useEffect(() => {
    localStorage.setItem(key, String(width));
  }, [key, width]);
  return {
    width,
    splitter: {
      onDragStart: () => {
        start.current = width;
      },
      onDrag: (travel: number) => setWidth(clamp(start.current + travel)),
      onStep: (d: number) => setWidth((w) => clamp(w + d)),
      onReset: () => setWidth(initial),
      value: width,
      min,
      max,
    },
  };
}
