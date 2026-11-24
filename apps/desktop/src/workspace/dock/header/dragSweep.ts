const LEFT_OVER = '.dv-drop-target-dropzone';

export function clearDropOverlays(doc: Document): number {
  const left = [...doc.querySelectorAll(LEFT_OVER)];
  for (const el of left) el.dispatchEvent(new Event('dragend', { bubbles: true }));
  return left.length;
}

export function installDragSweep(doc: Document): () => void {
  const win = doc.defaultView;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const later = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      clearDropOverlays(doc);
    }, 0);
  };
  const now = () => {
    if (doc.querySelector(LEFT_OVER)) clearDropOverlays(doc);
  };
  doc.addEventListener('dragend', later, true);
  doc.addEventListener('drop', later, true);
  doc.addEventListener('mousemove', now, true);
  doc.addEventListener('pointerdown', now, true);
  win?.addEventListener('blur', later);
  return () => {
    if (timer) clearTimeout(timer);
    doc.removeEventListener('dragend', later, true);
    doc.removeEventListener('drop', later, true);
    doc.removeEventListener('mousemove', now, true);
    doc.removeEventListener('pointerdown', now, true);
    win?.removeEventListener('blur', later);
  };
}
