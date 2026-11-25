import type { AttachmentInfo } from '@tessera/protocol';
import {
  Button,
  Loaded,
  Popover,
  PopoverContent,
  PopoverTrigger,
  TextInput,
  Tooltip,
  cx,
  formatShortcut,
  usePlatform,
} from '@tessera/ui';
import { Extension, type Editor, type Range } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from '@tiptap/markdown';
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  type ReactNodeViewProps,
} from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import Suggestion, { type SuggestionProps } from '@tiptap/suggestion';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { createEchoGuard } from '../../../app/echoGuard.ts';
import { noteSaves, type SaveState } from './noteSaves.ts';
import { createPortal } from 'react-dom';
import { useAttachmentUrl } from './hooks.ts';

function FileImageView({ node }: ReactNodeViewProps) {
  const src = String(node.attrs.src ?? '');
  const id = src.startsWith('file:') ? src.slice(5) : null;
  const alt = String(node.attrs.alt ?? '');
  return (
    <NodeViewWrapper as="span" className="jk-prose-img">
      {id ? (
        <Loaded alone label="Loading the image">
          <AttachedImage id={id} alt={alt} />
        </Loaded>
      ) : null}
      {!id && /^https?:/.test(src) ? <img src={src} alt={alt} /> : null}
    </NodeViewWrapper>
  );
}

function AttachedImage({ id, alt }: { id: string; alt: string }) {
  const url = useAttachmentUrl(id);
  return url ? <img src={url} alt={alt} /> : null;
}

const FileImage = Image.extend({
  addNodeView() {
    return ReactNodeViewRenderer(FileImageView);
  },
});

interface SlashItem {
  title: string;
  hint: string;
  run: (editor: Editor, range: Range) => void;
}

const SLASH: readonly SlashItem[] = [
  { title: 'Text', hint: 'Plain paragraph', run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run() },
  {
    title: 'Heading 1',
    hint: 'Large heading',
    run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 1 }).run(),
  },
  {
    title: 'Heading 2',
    hint: 'Medium heading',
    run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run(),
  },
  {
    title: 'Heading 3',
    hint: 'Small heading',
    run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run(),
  },
  { title: 'To-do list', hint: 'Track tasks', run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run() },
  {
    title: 'Bullet list',
    hint: 'Simple list',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
  },
  {
    title: 'Numbered list',
    hint: 'Ordered list',
    run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run(),
  },
  { title: 'Quote', hint: 'Blockquote', run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
  { title: 'Code', hint: 'Code block', run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },
  {
    title: 'Divider',
    hint: 'Separator line',
    run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run(),
  },
];

interface SlashState {
  items: SlashItem[];
  index: number;
  rect: DOMRect | null;
  pick: (item: SlashItem) => void;
}

const SLASH_EVENT = 'jk-slash';
const IMAGE_EVENT = 'jk-pick-image';

const SlashCommand = Extension.create({
  name: 'slashCommand',
  addProseMirrorPlugins() {
    const editor = this.editor;
    const items: SlashItem[] = [
      ...SLASH,
      {
        title: 'Image',
        hint: 'Upload an image',
        run: (e, r) => {
          e.chain().focus().deleteRange(r).run();
          e.view.dom.dispatchEvent(new CustomEvent(IMAGE_EVENT, { bubbles: true }));
        },
      },
    ];
    let state: SlashState | null = null;
    const emit = (next: SlashState | null) => {
      state = next;
      editor.view.dom.dispatchEvent(new CustomEvent(SLASH_EVENT, { detail: next, bubbles: true }));
    };
    const show = (p: SuggestionProps<SlashItem, SlashItem>, index = 0) =>
      emit({
        items: p.items,
        index: Math.min(index, Math.max(0, p.items.length - 1)),
        rect: p.clientRect?.() ?? null,
        pick: (item) => p.command(item),
      });
    return [
      Suggestion<SlashItem, SlashItem>({
        editor,
        char: '/',
        startOfLine: false,
        items: ({ query }) => items.filter((i) => i.title.toLowerCase().includes(query.toLowerCase())).slice(0, 12),
        command: ({ editor: e, range, props }) => props.run(e, range),
        render: () => ({
          onStart: (p) => show(p),
          onUpdate: (p) => show(p, state?.index ?? 0),
          onKeyDown: ({ event }) => {
            if (!state?.items.length) return false;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              const n = state.items.length;
              emit({ ...state, index: (state.index + (event.key === 'ArrowDown' ? 1 : n - 1)) % n });
              return true;
            }
            if (event.key === 'Enter') {
              const item = state.items[state.index];
              if (item) state.pick(item);
              return true;
            }
            if (event.key === 'Escape') {
              emit(null);
              return true;
            }
            return false;
          },
          onExit: () => emit(null),
        }),
      }),
    ];
  },
});

export function RichEditor({
  value,
  onSave,
  onAttach,
  placeholder,
  minHeight = 280,
  toolbar = true,
}: {
  value: string;
  onSave: (markdown: string) => Promise<unknown>;
  onAttach?: (file: File) => Promise<AttachmentInfo | null>;
  placeholder: string;
  minHeight?: number;
  toolbar?: boolean;
}) {
  const [state, setState] = useState<SaveState>('idle');
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [guard] = useState(() => {
    const g = createEchoGuard();
    g.agree(NOTE, value);
    return g;
  });
  const [saves] = useState(() => noteSaves({ saved: value, key: NOTE, guard, show: setState }));
  const timer = useRef<number | null>(null);
  const waiting = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const attach = useRef<(files: File[]) => void>(() => undefined);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      FileImage,
      Placeholder.configure({ placeholder: `${placeholder} Type / for commands.` }),
      Markdown,
      SlashCommand,
    ],
    content: value,
    contentType: 'markdown',
    immediatelyRender: true,
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: { class: 'jk-prose', 'aria-label': 'Journal entry' },
      handlePaste: (_view, e) => {
        const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
        if (!files.length) return false;
        attach.current(files);
        return true;
      },
      handleDrop: (_view, e) => {
        const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
        if (!files.length) return false;
        attach.current(files);
        return true;
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (timer.current) window.clearTimeout(timer.current);
      const md = ed.getMarkdown();
      waiting.current = md;
      timer.current = window.setTimeout(() => {
        timer.current = null;
        waiting.current = null;
        saves.save(md);
      }, 500);
    },
    onBlur: ({ editor: ed }) => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = null;
      waiting.current = null;
      saves.save(ed.getMarkdown());
    },
  });
  useEffect(() => {
    saves.sendWith(onSave);
    attach.current = (files: File[]) => {
      if (!onAttach) return;
      void (async () => {
        for (const f of files) {
          const att = await onAttach(f);
          if (att)
            editor
              .chain()
              .focus()
              .setImage({ src: `file:${att.id}`, alt: att.filename })
              .run();
        }
      })();
    };
  });
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dom = box.current;
    if (!dom) return;
    const onSlash = (e: Event) => setSlash((e as CustomEvent<SlashState | null>).detail);
    const onImage = () => fileInput.current?.click();
    dom.addEventListener(SLASH_EVENT, onSlash);
    dom.addEventListener(IMAGE_EVENT, onImage);
    return () => {
      dom.removeEventListener(SLASH_EVENT, onSlash);
      dom.removeEventListener(IMAGE_EVENT, onImage);
    };
  }, []);
  useEffect(() => {
    const own = editor.getMarkdown();
    if (!guard.admit(NOTE, value, own)) return;
    saves.agree(value);
    if (value !== own) editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false });
  }, [value, editor, guard, saves]);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
      if (waiting.current !== null) saves.save(waiting.current);
      saves.stop();
    },
    [saves],
  );
  return (
    <div className="jk-editor" ref={box}>
      {toolbar ? <Toolbar editor={editor} onImage={onAttach ? () => fileInput.current?.click() : undefined} /> : null}
      <BubbleMenu editor={editor} className="jk-bubble">
        <Tool label="Bold" on={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
          <b>B</b>
        </Tool>
        <Tool label="Italic" on={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
          <i>I</i>
        </Tool>
        <Tool
          label="Strikethrough"
          on={editor.isActive('strike')}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        >
          <s>S</s>
        </Tool>
        <Tool label="Code" on={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}>
          {'</>'}
        </Tool>
        <LinkTool editor={editor} />
      </BubbleMenu>
      <div className="jk-editor-body" style={{ minHeight }} onClick={() => editor.chain().focus().run()}>
        <EditorContent editor={editor} />
      </div>
      <div className="jk-editor-foot">
        <span className="text-t4">{footHint(!!onAttach)}</span>
        <span className={cx('jk-save', state === 'failed' && 'is-failed')}>
          {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : state === 'failed' ? 'Failed to save' : ''}
        </span>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          attach.current(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      {slash?.rect && slash.items.length
        ? createPortal(
            <div
              className="jk-slash"
              role="listbox"
              aria-label="Blocks"
              style={{ left: slash.rect.left, top: slash.rect.bottom + 6 }}
            >
              {slash.items.map((item, i) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={i === slash.index}
                  key={item.title}
                  className={cx(i === slash.index && 'is-on')}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    slash.pick(item);
                  }}
                >
                  <b>{item.title}</b>
                  <span className="text-t3 text-(length:--text-meta) leading-[13px]">{item.hint}</span>
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function Tool({
  label,
  on,
  onClick,
  children,
}: {
  label: string;
  on?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        className={cx('jk-tool', on && 'is-on')}
        aria-label={label}
        aria-pressed={on}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function LinkTool({ editor }: { editor: Editor }) {
  const [url, setUrl] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setUrl(String(editor.getAttributes('link').href ?? ''));
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cx('jk-tool', editor.isActive('link') && 'is-on')}
          aria-label="Insert link"
          onMouseDown={(e) => e.preventDefault()}
        >
          {LINK_GLYPH}
        </button>
      </PopoverTrigger>
      <PopoverContent className="jk-linkpop" align="start">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const href = url.trim();
            const chain = editor.chain().focus().extendMarkRange('link');
            if (href) chain.setLink({ href: /^[a-z]+:/i.test(href) ? href : `https://${href}` }).run();
            else chain.unsetLink().run();
            setOpen(false);
          }}
        >
          <TextInput
            size="s"
            autoFocus
            value={url}
            placeholder="https://"
            aria-label="Link"
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button size="s" type="submit">
            {url.trim() ? 'Link' : 'Remove'}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

interface FormatTool {
  label: string;
  shortcut?: string;
  glyph: ReactNode;
  active: (e: Editor) => boolean;
  run: (e: Editor) => void;
}

const FORMAT_TOOLS: readonly (readonly FormatTool[])[] = [
  [
    {
      label: 'Bold',
      shortcut: 'mod+b',
      glyph: <b>B</b>,
      active: (e) => e.isActive('bold'),
      run: (e) => e.chain().focus().toggleBold().run(),
    },
    {
      label: 'Italic',
      shortcut: 'mod+i',
      glyph: <i>I</i>,
      active: (e) => e.isActive('italic'),
      run: (e) => e.chain().focus().toggleItalic().run(),
    },
    {
      label: 'Strikethrough',
      glyph: <s>S</s>,
      active: (e) => e.isActive('strike'),
      run: (e) => e.chain().focus().toggleStrike().run(),
    },
  ],
  ([1, 2, 3] as const).map((level) => ({
    label: `Heading ${String(level)}`,
    glyph: `H${String(level)}`,
    active: (e: Editor) => e.isActive('heading', { level }),
    run: (e: Editor) => e.chain().focus().toggleHeading({ level }).run(),
  })),
  [
    {
      label: 'Bullet list',
      glyph: '•',
      active: (e) => e.isActive('bulletList'),
      run: (e) => e.chain().focus().toggleBulletList().run(),
    },
    {
      label: 'Numbered list',
      glyph: '1.',
      active: (e) => e.isActive('orderedList'),
      run: (e) => e.chain().focus().toggleOrderedList().run(),
    },
    {
      label: 'To-do list',
      glyph: '☐',
      active: (e) => e.isActive('taskList'),
      run: (e) => e.chain().focus().toggleTaskList().run(),
    },
  ],
];

const LINK_GLYPH = '↗';
const IMAGE_GLYPH = '▣';

function footHint(attach: boolean): string {
  return `Markdown · / for blocks${attach ? ' · paste a screenshot' : ''}`;
}

function Toolbar({ editor, onImage }: { editor: Editor; onImage: (() => void) | undefined }) {
  const platform = usePlatform();
  return (
    <div className="jk-toolbar" role="toolbar" aria-label="Formatting">
      {FORMAT_TOOLS.map((group, i) => (
        <Fragment key={i}>
          {i ? <span className="jk-toolbar-sep" /> : null}
          {group.map((t) => (
            <Tool
              key={t.label}
              label={t.shortcut ? `${t.label} (${formatShortcut(t.shortcut, platform)})` : t.label}
              on={t.active(editor)}
              onClick={() => t.run(editor)}
            >
              {t.glyph}
            </Tool>
          ))}
        </Fragment>
      ))}
      <span className="jk-toolbar-sep" />
      <LinkTool editor={editor} />
      {onImage ? (
        <Tool label="Insert image" onClick={onImage}>
          {IMAGE_GLYPH}
        </Tool>
      ) : null}
    </div>
  );
}

export function EditorSample({
  lines,
  minHeight = 280,
  attach = true,
}: {
  lines: readonly string[];
  minHeight?: number;
  attach?: boolean;
}) {
  return (
    <div className="jk-editor">
      <div className="jk-toolbar">
        {FORMAT_TOOLS.map((group, i) => (
          <Fragment key={i}>
            {i ? <span className="jk-toolbar-sep" /> : null}
            {group.map((t) => (
              <span key={t.label} className="jk-tool">
                {t.glyph}
              </span>
            ))}
          </Fragment>
        ))}
        <span className="jk-toolbar-sep" />
        <span className="jk-tool">{LINK_GLYPH}</span>
        {attach ? <span className="jk-tool">{IMAGE_GLYPH}</span> : null}
      </div>
      <div className="jk-editor-body" style={{ minHeight }}>
        <div className="jk-prose">
          {lines.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
      </div>
      <div className="jk-editor-foot">
        <span className="text-t4">{footHint(attach)}</span>
        <span className="jk-save" />
      </div>
    </div>
  );
}

const NOTE = 'note';
