import type { Child } from 'hono/jsx';
import type { AlignType, List, Nodes, RootContent, Table } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

const DEEPEST = 24;
const MOST_MARKS = 5000;
const MARK = /[*_]+|[[>]/g;

export function Markdown(props: { text: string }) {
  const { text } = props;
  if (marksIn(text) > MOST_MARKS) {
    return (
      <div class="md">
        <p class="plain">{text}</p>
      </div>
    );
  }
  const tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  return <div class="md">{all(tree.children, 0, 'block')}</div>;
}

function marksIn(text: string): number {
  let marks = 0;
  for (MARK.lastIndex = 0; MARK.exec(text) !== null;) marks += 1;
  return marks;
}

type Place = 'block' | 'tight' | 'inline';

function all(nodes: readonly RootContent[], depth: number, place: Place = 'inline'): Child[] {
  return nodes.map((node) => one(node, depth + 1, place));
}

function one(node: RootContent, depth: number, place: Place): Child {
  if (depth > DEEPEST) return plainText(node);
  switch (node.type) {
    case 'text':
      return node.value;
    case 'html':
      return place === 'block' ? <p>{node.value}</p> : node.value;
    case 'paragraph':
      if (node.children.every((child) => child.type === 'image' || child.type === 'imageReference')) return null;
      return place === 'tight' ? <>{all(node.children, depth)}</> : <p>{all(node.children, depth)}</p>;
    case 'heading':
      return heading(node.depth, all(node.children, depth));
    case 'emphasis':
      return <em>{all(node.children, depth)}</em>;
    case 'strong':
      return <strong>{all(node.children, depth)}</strong>;
    case 'delete':
      return <del>{all(node.children, depth)}</del>;
    case 'inlineCode':
      return <code>{node.value}</code>;
    case 'code':
      return (
        <pre>
          <code>{node.value}</code>
        </pre>
      );
    case 'blockquote':
      return <blockquote>{all(node.children, depth, 'block')}</blockquote>;
    case 'list':
      return list(node, depth);
    case 'listItem':
      return (
        <li>
          {node.checked === null || node.checked === undefined ? null : (
            <input type="checkbox" disabled checked={node.checked} />
          )}
          {all(node.children, depth, place)}
        </li>
      );
    case 'thematicBreak':
      return <hr />;
    case 'break':
      return <br />;
    case 'link':
    case 'linkReference':
      return <span class="ln">{all(node.children, depth)}</span>;
    case 'footnoteReference':
      return `[${node.label ?? node.identifier}]`;
    case 'footnoteDefinition':
      return (
        <div class="fn">
          <span class="fn-label">{`[${node.label ?? node.identifier}]`}</span>
          {all(node.children, depth, 'block')}
        </div>
      );
    case 'table':
      return table(node, depth);
    case 'tableRow':
    case 'tableCell':
      return <>{all(node.children, depth)}</>;
    case 'image':
    case 'imageReference':
    case 'definition':
    case 'yaml':
      return null;
  }
}

function heading(level: number, children: Child[]): Child {
  if (level <= 1) return <h2>{children}</h2>;
  if (level === 2) return <h3>{children}</h3>;
  return <h4>{children}</h4>;
}

function list(node: List, depth: number): Child {
  const tight = node.spread !== true && node.children.every((item) => item.spread !== true);
  const items = all(node.children, depth, tight ? 'tight' : 'block');
  if (node.ordered !== true) return <ul>{items}</ul>;
  return <ol start={node.start === 1 ? undefined : (node.start ?? undefined)}>{items}</ol>;
}

const ALIGN_CLASS: Record<NonNullable<AlignType>, string | undefined> = {
  left: undefined,
  center: 'al-c',
  right: 'al-r',
};

function table(node: Table, depth: number): Child {
  const [head, ...body] = node.children;
  const align = (i: number) => {
    const side = node.align?.[i];
    return side === null || side === undefined ? undefined : ALIGN_CLASS[side];
  };
  return (
    <div class="md-table">
      <table>
        {head === undefined ? null : (
          <thead>
            <tr>
              {head.children.map((cell, i) => (
                <th class={align(i)}>{all(cell.children, depth)}</th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {body.map((row) => (
            <tr>
              {row.children.map((cell, i) => (
                <td class={align(i)}>{all(cell.children, depth)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function plainText(node: Nodes): string {
  const words: string[] = [];
  const stack: Nodes[] = [node];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if ('value' in next) words.push(next.value);
    else if ('children' in next) stack.push(...next.children.toReversed());
  }
  return words.join(' ');
}
