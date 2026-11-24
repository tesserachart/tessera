export type Inline =
  | { t: 'text'; v: string }
  | { t: 'b'; c: Inline[] }
  | { t: 'i'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'img'; src: string; alt: string };

export type Block =
  | { t: 'h'; level: 1 | 2 | 3; c: Inline[] }
  | { t: 'p'; c: Inline[] }
  | { t: 'ul'; items: { c: Inline[]; task: boolean | null }[] }
  | { t: 'ol'; items: { c: Inline[] }[] }
  | { t: 'quote'; c: Inline[] }
  | { t: 'hr' }
  | { t: 'pre'; v: string };

const SAFE_HREF = /^(https?:|mailto:|file:)/i;

export function inline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^!\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest))) {
      flush();
      out.push({ t: 'img', alt: m[1] ?? '', src: m[2] ?? '' });
      i += m[0].length;
    } else if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) {
      flush();
      const href = m[2] ?? '';
      if (SAFE_HREF.test(href)) out.push({ t: 'link', href, c: inline(m[1] ?? '') });
      else out.push({ t: 'text', v: m[1] ?? '' });
      i += m[0].length;
    } else if ((m = /^`([^`]+)`/.exec(rest))) {
      flush();
      out.push({ t: 'code', v: m[1] ?? '' });
      i += m[0].length;
    } else if ((m = /^\*\*([^*]+)\*\*/.exec(rest)) || (m = /^__([^_]+)__/.exec(rest))) {
      flush();
      out.push({ t: 'b', c: inline(m[1] ?? '') });
      i += m[0].length;
    } else if ((m = /^\*([^*\s][^*]*)\*/.exec(rest)) || (m = /^_([^_\s][^_]*)_(?![A-Za-z0-9])/.exec(rest))) {
      flush();
      out.push({ t: 'i', c: inline(m[1] ?? '') });
      i += m[0].length;
    } else {
      buf += s.charAt(i);
      i += 1;
    }
  }
  flush();
  return out;
}

export function parse(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) out.push({ t: 'p', c: inline(para.join(' ')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    let m: RegExpExecArray | null;
    if (!trimmed) {
      endPara();
    } else if (trimmed.startsWith('```')) {
      endPara();
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) body.push(lines[i++] ?? '');
      out.push({ t: 'pre', v: body.join('\n') });
    } else if ((m = /^(#{1,3})\s+(.*)$/.exec(trimmed))) {
      endPara();
      out.push({ t: 'h', level: (m[1]?.length ?? 1) as 1 | 2 | 3, c: inline(m[2] ?? '') });
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      endPara();
      out.push({ t: 'hr' });
    } else if (trimmed.startsWith('>')) {
      endPara();
      const body = [trimmed.replace(/^>\s?/, '')];
      while (i + 1 < lines.length && (lines[i + 1] ?? '').trim().startsWith('>')) {
        body.push((lines[++i] ?? '').trim().replace(/^>\s?/, ''));
      }
      out.push({ t: 'quote', c: inline(body.join(' ')) });
    } else if (/^[-*+]\s+/.test(trimmed)) {
      endPara();
      const items: { c: Inline[]; task: boolean | null }[] = [];
      let j = i;
      while (j < lines.length && /^[-*+]\s+/.test((lines[j] ?? '').trim())) {
        const body = (lines[j] ?? '').trim().replace(/^[-*+]\s+/, '');
        const task = /^\[([ xX])\]\s*/.exec(body);
        items.push({
          c: inline(task ? body.slice(task[0].length) : body),
          task: task ? task[1] !== ' ' : null,
        });
        j++;
      }
      i = j - 1;
      out.push({ t: 'ul', items });
    } else if (/^\d+[.)]\s+/.test(trimmed)) {
      endPara();
      const items: { c: Inline[] }[] = [];
      let j = i;
      while (j < lines.length && /^\d+[.)]\s+/.test((lines[j] ?? '').trim())) {
        items.push({ c: inline((lines[j] ?? '').trim().replace(/^\d+[.)]\s+/, '')) });
        j++;
      }
      i = j - 1;
      out.push({ t: 'ol', items });
    } else {
      para.push(trimmed);
    }
  }
  endPara();
  return out;
}

export function plainText(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function toggleTask(md: string, n: number): string {
  let k = -1;
  return md.replace(/^(\s*[-*+]\s+\[)([ xX])(\])/gm, (all, a: string, mark: string, b: string) => {
    k += 1;
    return k === n ? `${a}${mark === ' ' ? 'x' : ' '}${b}` : all;
  });
}
