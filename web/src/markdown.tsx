import type { ReactNode } from "react";

/**
 * A deliberately tiny Markdown renderer for plan text. The text is untrusted (it comes from the agent), so it only ever
 * produces React elements from plain strings: no raw HTML, no links, no images. Anything unrecognised is literal text.
 */

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text
    .split(INLINE)
    .filter((part) => part !== "")
    .map((part, i) => {
      const key = `${keyPrefix}-${i}`;
      if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
        return <code key={key}>{part.slice(1, -1)}</code>;
      }
      if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
        return <strong key={key}>{part.slice(2, -2)}</strong>;
      }
      return part;
    });
}

interface ListItem {
  text: string;
  children: ListItem[];
  ordered: boolean;
}

const LIST_LINE = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

function renderList(items: ListItem[], key: string): ReactNode {
  const Tag = items[0]?.ordered ? "ol" : "ul";
  return (
    <Tag key={key}>
      {items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static, never reordered
        <li key={i}>
          {renderInline(item.text, `${key}-${i}`)}
          {item.children.length > 0 && renderList(item.children, `${key}-${i}c`)}
        </li>
      ))}
    </Tag>
  );
}

export function renderMarkdown(source: string): ReactNode[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let n = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const key = `b${n++}`;

    if (line.trimStart().startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith("```")) {
        code.push(lines[i] ?? "");
        i++;
      }
      i++; // closing fence (or end of text)
      out.push(
        <pre key={key}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const Tag = (heading[1] ?? "#").length <= 2 ? "h5" : "h6";
      out.push(<Tag key={key}>{renderInline(heading[2] ?? "", key)}</Tag>);
      i++;
      continue;
    }

    if (LIST_LINE.test(line)) {
      const top: ListItem[] = [];
      while (i < lines.length) {
        const m = LIST_LINE.exec(lines[i] ?? "");
        if (!m) break;
        const item: ListItem = { text: m[3] ?? "", children: [], ordered: /\d/.test(m[2] ?? "") };
        const last = top[top.length - 1];
        if ((m[1] ?? "").length >= 2 && last) last.children.push(item);
        else top.push(item);
        i++;
      }
      out.push(renderList(top, key));
      continue;
    }

    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? "";
      if (l.trim() === "" || l.trimStart().startsWith("```") || /^#{1,4}\s/.test(l) || LIST_LINE.test(l))
        break;
      para.push(l);
      i++;
    }
    out.push(<p key={key}>{renderInline(para.join("\n"), key)}</p>);
  }
  return out;
}
