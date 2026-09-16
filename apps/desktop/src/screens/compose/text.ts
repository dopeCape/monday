// The plain-text alternative of a Draft, from the editor's document (ADR 0010:
// every send carries text and html). Pure: walks ProseMirror JSON, so it needs
// no DOM and the same document always yields the same text. Lists become "- "
// and "1. " lines, quotes become "> " lines, code blocks are indented, links
// keep their address in angle brackets when it differs from the text.

export interface DocNode {
  type: string;
  attrs?: Record<string, unknown> | undefined;
  content?: DocNode[] | undefined;
  text?: string | undefined;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> | undefined }> | undefined;
}

function inline(node: DocNode): string {
  if (node.type === "text") {
    const text = node.text ?? "";
    const link = node.marks?.find((m) => m.type === "link");
    const href = typeof link?.attrs?.href === "string" ? link.attrs.href : null;
    if (href && href !== text && href !== `mailto:${text}`) return `${text} <${href}>`;
    return text;
  }
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(inline).join("");
}

function blocks(node: DocNode, prefix = ""): string[] {
  const out: string[] = [];
  const children = node.content ?? [];
  switch (node.type) {
    case "paragraph":
    case "heading":
      out.push(prefix + inline(node).replace(/\n/g, `\n${prefix}`));
      return out;
    case "codeBlock":
      out.push(
        inline(node)
          .split("\n")
          .map((l) => `${prefix}    ${l}`)
          .join("\n"),
      );
      return out;
    case "blockquote":
      for (const child of children) out.push(...blocks(child, `${prefix}> `));
      return out;
    case "bulletList":
      out.push(children.flatMap((item) => listItem(item, `${prefix}- `, prefix)).join("\n"));
      return out;
    case "orderedList": {
      const start = typeof node.attrs?.start === "number" ? node.attrs.start : 1;
      out.push(
        children.flatMap((item, i) => listItem(item, `${prefix}${start + i}. `, prefix)).join("\n"),
      );
      return out;
    }
    case "horizontalRule":
      out.push(`${prefix}---`);
      return out;
    default:
      for (const child of children) out.push(...blocks(child, prefix));
      return out;
  }
}

/** A list item: the marker on its first line, the rest indented to match. */
function listItem(item: DocNode, marker: string, prefix: string): string[] {
  const indent = prefix + " ".repeat(marker.length - prefix.length);
  const parts: string[] = [];
  for (const [i, child] of (item.content ?? []).entries()) {
    const lines = blocks(child, i === 0 ? prefix : indent);
    if (i === 0 && lines[0] !== undefined) lines[0] = marker + lines[0].slice(prefix.length);
    parts.push(...lines);
  }
  return [parts.join("\n")];
}

/** The text alternative for a document: blocks separated by blank lines. */
export function docToText(doc: DocNode): string {
  return blocks(doc)
    .join("\n\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .trimEnd();
}
