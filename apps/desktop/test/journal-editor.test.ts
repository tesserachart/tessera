// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Markdown } from '@tiptap/markdown';

const md = `# Plan

Wait for the **open** and *trade* the \`ORB\`.

- [ ] Levels marked
- [x] News checked

1. First
2. Second

> Patience

![chart](file:abc123)

---

[link](https://example.com)`;

describe('editor markdown', () => {
  it('round-trips a note unchanged', () => {
    const editor = new Editor({
      extensions: [StarterKit, TaskList, TaskItem.configure({ nested: true }), Image, Markdown],
      content: md,
      contentType: 'markdown',
    });
    expect(editor.getMarkdown()).toBe(md);
    editor.destroy();
  });
});
