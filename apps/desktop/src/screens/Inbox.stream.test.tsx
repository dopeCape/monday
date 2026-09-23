/// <reference types="bun-types" />
// The stream under real-mailbox conditions: a read Thread keeps its place,
// a sender with no name still reads as someone, a long list renders only
// what is near the view, the Filter menu narrows the Sections. Mounted under
// a StaticShell over fixtures with happy-dom.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { PartialSettings, Thread } from "@monday/shared";
import { threads as fixtureThreads } from "@monday/ui/fixtures";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { StaticShell } from "../shell/Shell.tsx";
import { Inbox, type InboxProps } from "./Inbox.tsx";
import { fixtureInbox, type Inbox as InboxData } from "./inbox/actions.ts";

let createRoot: Awaited<ReturnType<typeof dom>>["createRoot"];
beforeAll(async () => {
  ({ createRoot } = await dom());
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function mount(props: Partial<InboxProps> = {}, settings: PartialSettings = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  const data = props.inbox ?? fixtureInbox();
  await act(async () =>
    r.render(
      <StaticShell settings={{ "ai.level": "automate", ...settings }}>
        <Inbox
          now={new Date(2026, 8, 16, 10, 0)}
          initialOpen={null}
          timing={{ collapse: 0, toast: 60_000 }}
          {...props}
          inbox={data}
        />
      </StaticShell>,
    ),
  );
  return data;
}

async function press(key: string, mods: Partial<KeyboardEventInit> = {}) {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }),
    );
  });
}

const rowIds = () =>
  [...document.querySelectorAll<HTMLElement>(".list .row")].map((r) => r.dataset.thread);
/** Each Section heading with the rows under it, in document order. */
const sections = () => {
  const out: Array<{ name: string; rows: string[] }> = [];
  for (const el of document.querySelectorAll<HTMLElement>(".list .col-body .sec, .list .row")) {
    if (el.classList.contains("sec")) out.push({ name: el.textContent ?? "", rows: [] });
    else out[out.length - 1]?.rows.push(el.dataset.thread ?? "");
  }
  return out;
};
const reader = () => document.querySelector<HTMLElement>(".reader")?.dataset.thread ?? null;

/**
 * The fixtures behind a seam that re-sections on read, as the old shipped
 * rule did: a read Thread in Needs your reply drops to For your information.
 */
function resectioning(base: InboxData): InboxData {
  const view = (t: Thread): Thread =>
    t.section === "needs-reply" && !t.unread ? { ...t, section: "fyi" } : t;
  let source: readonly Thread[] | null = null;
  let out: readonly Thread[] = [];
  return {
    ...base,
    threads: () => {
      const now = base.threads();
      if (now !== source) {
        source = now;
        out = now.map(view);
      }
      return out;
    },
    thread: (id) => {
      const t = base.thread(id);
      return t ? view(t) : undefined;
    },
  };
}

describe("a Thread keeps its place while the user reads it", () => {
  test("opening a Thread reads it, drops its unread look, and leaves it where it was", async () => {
    const inbox = resectioning(fixtureInbox());
    await mount({ inbox });
    const before = sections();
    expect(before[0]?.name).toBe("Needs your reply");
    expect(before[0]?.rows).toContain("e1");
    await act(async () => document.querySelector<HTMLElement>(".row[data-thread=e1]")?.click());
    expect(reader()).toBe("e1");
    // The seam now puts e1 under For your information; the stream holds it.
    expect(inbox.thread("e1")?.section).toBe("fyi");
    expect(sections()).toEqual(before);
    const row = document.querySelector(".row[data-thread=e1]");
    expect(row?.classList.contains("unread")).toBe(false);
    expect(row?.classList.contains("on")).toBe(true);
    // Moving on and closing the reader does not move it either.
    await press("Escape");
    await press("j");
    expect(sections()).toEqual(before);
  });

  test("a rebuilt stream (a new mount) takes the Sections the rules give now", async () => {
    const inbox = resectioning(fixtureInbox());
    await inbox.markRead(["e1"]);
    await mount({ inbox });
    const fyi = sections().find((s) => s.name === "For your information");
    expect(fyi?.rows).toContain("e1");
  });

  test("archive still removes the row", async () => {
    const inbox = resectioning(fixtureInbox());
    await mount({ inbox, initialOpen: "e1" });
    await press("e");
    expect(rowIds()).not.toContain("e1");
  });
});

describe("a sender with no name", () => {
  test("the row reads the address's local part, prettified, or the local part as written", async () => {
    const [a, b] = fixtureThreads as [Thread, Thread];
    const inbox = fixtureInbox([
      { ...a, id: "n1", messageCount: 1, participants: [{ name: "", email: "aoife.byrne@x.dev" }] },
      {
        ...b,
        id: "n2",
        messageCount: 1,
        participants: [{ name: "", email: "noreply@github.com" }],
      },
    ]);
    await mount({ inbox });
    const from = (id: string) =>
      document.querySelector(`.row[data-thread=${id}] .from`)?.textContent?.trim();
    expect(from("n1")).toBe("Aoife Byrne");
    expect(from("n2")).toBe("noreply");
  });
});
