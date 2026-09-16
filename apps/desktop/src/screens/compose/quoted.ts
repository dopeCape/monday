// The quoted history inside the editor: a block node that keeps the answered
// Message as <div class="quoted"> (so the sent HTML carries the marker and
// the reader folds it) and shows it folded behind a toggle while writing.

import { mergeAttributes, Node } from "@tiptap/core";

export interface QuotedOptions {
  /** The toggle's accessible name. */
  label: string;
}

export const Quoted = Node.create<QuotedOptions>({
  name: "quoted",
  group: "block",
  content: "block+",
  defining: true,
  isolating: true,

  addOptions() {
    return { label: "Quoted text" };
  },

  addAttributes() {
    return {
      open: {
        default: false,
        parseHTML: (element) => element.getAttribute("data-open") === "true",
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div.quoted" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { class: "quoted" }), 0];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement("div");
      dom.className = "quoted";
      dom.dataset.open = String(node.attrs.open);
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "quoted-toggle";
      toggle.contentEditable = "false";
      toggle.title = this.options.label;
      toggle.setAttribute("aria-label", this.options.label);
      toggle.textContent = "•••";
      toggle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const pos = getPos();
        if (pos === undefined) return;
        const current = editor.state.doc.nodeAt(pos);
        if (!current) return;
        editor.view.dispatch(
          editor.state.tr.setNodeMarkup(pos, undefined, {
            ...current.attrs,
            open: !current.attrs.open,
          }),
        );
      });
      const contentDOM = document.createElement("div");
      contentDOM.className = "quoted-body";
      dom.append(toggle, contentDOM);
      return {
        dom,
        contentDOM,
        update(updated) {
          if (updated.type.name !== "quoted") return false;
          dom.dataset.open = String(updated.attrs.open);
          return true;
        },
      };
    };
  },
});
