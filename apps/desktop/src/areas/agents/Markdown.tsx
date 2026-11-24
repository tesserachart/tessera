import { Button } from '@tessera/ui';
import { memo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { openExternal } from '../../app/host.ts';

const PLUGINS = [remarkGfm];

function CodeBlock({ children }: { children?: ReactNode }) {
  const pre = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const lang = /language-(\w+)/.exec(
    (children as { props?: { className?: string } } | undefined)?.props?.className ?? '',
  )?.[1];
  return (
    <div className="md-code">
      <div className="md-code-head" data-selectable={false}>
        <span>{lang ?? ''}</span>
        <Button
          size="s"
          variant="quiet"
          onClick={() => {
            const text = pre.current?.textContent ?? '';
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre ref={pre}>{children}</pre>
    </div>
  );
}

function Link({ href, children }: ComponentProps<'a'>) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(e) => {
        if (!href) return;
        e.preventDefault();
        void openExternal(href).catch(() => undefined);
      }}
    >
      {children}
    </a>
  );
}

const COMPONENTS: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) => <Link href={href}>{children}</Link>,
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
};

const rendered = new Map<string, ReactNode>();
const RENDERED_MAX = 400;

function render(text: string): ReactNode {
  const hit = rendered.get(text);
  if (hit !== undefined) {
    rendered.delete(text);
    rendered.set(text, hit);
    return hit;
  }
  // react-markdown's component is a plain function (no hooks): called, it gives the tree
  const tree = ReactMarkdown({ children: text, remarkPlugins: PLUGINS, components: COMPONENTS });
  rendered.set(text, tree);
  const oldest = rendered.keys().next();
  if (rendered.size > RENDERED_MAX && !oldest.done) rendered.delete(oldest.value);
  return tree;
}

export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="md" data-streaming={streaming ? '' : undefined}>
      {streaming ? (
        <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>
          {text}
        </ReactMarkdown>
      ) : (
        render(text)
      )}
    </div>
  );
});
