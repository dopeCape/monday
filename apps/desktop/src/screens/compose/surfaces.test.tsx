/// <reference types="bun-types" />
// The compose surfaces on the Inbox screen through the DOM (happy-dom):
// C opens the overlay, R opens the inline reply prefilled per the reply-all
// rule, Send shows the Undo bar counting down from the delay Setting, Undo
// cancels the send and reopens the Draft, and uploads show their progress.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { PartialSettings } from "@monday/shared";
import type { Editor as TiptapEditor } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StaticShell } from "../../shell/Shell.tsx";
import { Inbox, type InboxProps } from "../Inbox.tsx";
import { fixtureInbox } from "../inbox/actions.ts";
import { Attachments } from "./Attachments.tsx";
import { fixtureComposer } from "./composer.ts";
import { UndoBar } from "./UndoBar.tsx";

beforeAll(() => {
  if (typeof document === "undefined") GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await act(async () => {
      await tick();
    });
  }
  throw new Error("condition not met");
}

const NOW = new Date(2026, 8, 16, 10, 0);

async function mount(props: Partial<InboxProps> = {}, settings: PartialSettings = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  const inbox = props.inbox ?? fixtureInbox();
  const composer = props.composer ?? fixtureComposer({ now: () => NOW });
  const render = async (more: Partial<InboxProps> = {}) =>
    act(async () =>
      r.render(
        <StaticShell settings={settings}>
          <Inbox
            now={NOW}
            initialOpen={null}
            timing={{ collapse: 0, toast: 60_000 }}
            {...props}
            {...more}
            inbox={inbox}
            composer={composer}
          />
        </StaticShell>,
      ),
    );
  await render();
  return { inbox, composer, render };
}

async function press(key: string, mods: Partial<KeyboardEventInit> = {}) {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }),
    );
  });
}

async function click(el: Element | null) {
  if (!el) throw new Error("nothing to click");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

const overlay = () => document.querySelector<HTMLElement>(".compose");
const pills = (scope: ParentNode = document) =>
  [...scope.querySelectorAll<HTMLElement>(".pill")].map((p) => p.title || p.textContent?.trim());

describe("compose overlay", () => {
  test("C opens a new message; Esc closes it", async () => {
    await mount();
    expect(overlay()).toBeNull();
    await press("c");
    expect(overlay()).not.toBeNull();
    expect(overlay()?.querySelector("h2")?.textContent).toBe("New message");
    expect(overlay()?.querySelector(".tiptap")).not.toBeNull();
    await press("Escape");
    expect(overlay()).toBeNull();
  });

  test("the nav's compose request opens it too", async () => {
    const { render } = await mount({ composeRequest: 0 });
    expect(overlay()).toBeNull();
    await render({ composeRequest: 1 });
    expect(overlay()).not.toBeNull();
  });

  test("a saved Draft reopens with its recipients and subject, and Send needs a recipient", async () => {
    const composer = fixtureComposer({ now: () => NOW });
    await composer.save("d9", {
      threadId: null,
      kind: "new",
      inReplyToMessageId: null,
      to: [{ name: "Aoife Brennan", email: "aoife@northlight.dev" }],
      cc: [],
      bcc: [],
      subject: "Saved earlier",
      bodyHtml: "<p>Body</p>",
      bodyText: "Body",
      attachments: [],
    });
    await mount({ composer, initialCompose: "d9" });
    await until(() => overlay() !== null);
    expect(pills(overlay() ?? undefined)).toEqual(["aoife@northlight.dev"]);
    expect(overlay()?.querySelector<HTMLInputElement>("#compose-subject")?.value).toBe(
      "Saved earlier",
    );
    expect(overlay()?.querySelector(".tiptap")?.textContent).toBe("Body");
    const send = overlay()?.querySelector<HTMLButtonElement>(".c-foot .btn.primary");
    expect(send?.disabled).toBe(false);
  });
});

describe("inline reply", () => {
  test("R replies to the sender; the last Message with two recipients replies to all", async () => {
    const { composer } = await mount({ initialOpen: "e2" });
    // e2: Kenji wrote to Tejas and Ravi, so the rule answers everyone.
    await press("r");
    const reply = document.querySelector(".reply");
    expect(reply).not.toBeNull();
    await until(() => document.querySelector(".reply .tiptap") !== null);
    expect(pills(reply ?? undefined)).toEqual(["kenji.w@meridianfund.co", "ravi@genai-labs.io"]);
    expect(document.querySelector(".reply .quoted")).not.toBeNull();
    expect(document.querySelector(".reply .quoted[data-open='false']")).not.toBeNull();
    // The toggle answers the sender only and is remembered for the Thread.
    await click(document.querySelector(".reply-bottom .btn.on"));
    expect(pills(document.querySelector(".reply") ?? undefined)).toEqual([
      "kenji.w@meridianfund.co",
    ]);
    expect(composer.replyAllFor("e2")).toBe(false);
  });

  test("a single-recipient Message replies to the sender only; A forces reply all", async () => {
    await mount({ initialOpen: "e1" });
    await press("r");
    await until(() => document.querySelector(".reply .tiptap") !== null);
    expect(pills(document.querySelector(".reply") ?? undefined)).toEqual(["aoife@northlight.dev"]);
    await press("Escape");
    await press("a");
    await until(() => document.querySelector(".reply .tiptap") !== null);
    expect(document.querySelector(".reply-bottom .btn.on")).not.toBeNull();
  });

  test("F forwards with the original attachments and a checkbox", async () => {
    await mount({ initialOpen: "e1" }, { "send.forward_attachments": true });
    await press("f");
    await until(() => document.querySelector(".reply .tiptap") !== null);
    const box = document.querySelector<HTMLInputElement>(".reply-meta input[type=checkbox]");
    expect(box?.checked).toBe(true);
    expect(
      [...document.querySelectorAll(".c-atts .att span:nth-child(2)")].map((s) => s.textContent),
    ).toEqual(["take-home-writeup.pdf", "sync-model.png"]);
    await click(box);
    await until(() => document.querySelectorAll(".c-atts .att").length === 0);
  });
});

describe("Brief action chips (slice 13)", () => {
  const chip = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(".reader .brief-actions .chip")].find(
      (b) => b.textContent === label,
    ) ?? null;

  test("a reply chip opens the reply seeded with the proposed line and sends nothing", async () => {
    const { composer } = await mount({ initialOpen: "e1" });
    await click(chip("Reply with Thursday 15:00"));
    await until(() => document.querySelector(".reply .tiptap") !== null);
    expect(document.querySelector(".reply .tiptap")?.textContent).toContain(
      "Thursday 15:00 CET works for me.",
    );
    expect(pills(document.querySelector(".reply") ?? undefined)).toEqual(["aoife@northlight.dev"]);
    expect(composer.sends()).toEqual([]);
  });

  test("a forward chip opens a forward addressed to the person; a calendar chip says the calendar is not connected", async () => {
    await mount({ initialOpen: "e1" });
    await click(chip("Forward to Priya"));
    await until(() => document.querySelector(".reply .tiptap") !== null);
    expect(pills(document.querySelector(".reply") ?? undefined)).toEqual(["priya@genai-labs.io"]);
    expect(document.querySelector(".reply .quoted")).not.toBeNull();
    await click(chip("Add to interview calendar"));
    await until(() => document.querySelector(".toast") !== null);
    expect(document.querySelector(".toast")?.textContent).toContain(
      "Calendar is not connected yet",
    );
  });
});

describe("send and undo", () => {
  test("Send shows the countdown from the delay Setting; Undo cancels and reopens the Draft", async () => {
    const composer = fixtureComposer({ now: () => NOW, delaySeconds: 30 });
    await mount({ composer, initialOpen: "e1" }, { "send.delay_seconds": 30 });
    await press("r");
    await until(() => document.querySelector(".reply .tiptap") !== null);
    await click(document.querySelector(".reply-bottom .btn.primary"));
    await until(() => document.querySelector("[data-send-undo]") !== null);
    expect(document.querySelector("[data-send-undo]")?.textContent).toContain("Sending in 30s");
    expect(document.querySelector(".reply .tiptap")).toBeNull();
    expect(composer.sends()[0]?.status).toBe("scheduled");
    expect(composer.drafts()[0]?.status).toBe("scheduled");
    expect(composer.drafts()[0]?.to[0]?.email).toBe("aoife@northlight.dev");

    await click(document.querySelector("[data-send-undo] .btn"));
    await until(() => document.querySelector("[data-send-undo]") === null);
    expect(composer.sends()[0]?.status).toBe("cancelled");
    expect(composer.drafts()[0]?.status).toBe("open");
    await until(() => document.querySelector(".reply .tiptap") !== null);
    expect(document.querySelector(".toast")?.textContent).toContain("Send cancelled");
  });

  test("Send schedules with the delay Setting even when the Composer applies none itself", async () => {
    // The Store composer runs the send Job at `now` plus what it is told; a
    // surface that told it nothing left no undo window (the bar read 0s).
    const composer = fixtureComposer({ now: () => NOW, delaySeconds: 0 });
    await mount({ composer, initialOpen: "e1" }, { "send.delay_seconds": 45 });
    await press("r");
    await until(() => document.querySelector(".reply .tiptap") !== null);
    await click(document.querySelector(".reply-bottom .btn.primary"));
    await until(() => document.querySelector("[data-send-undo]") !== null);
    expect(document.querySelector("[data-send-undo]")?.textContent).toContain("Sending in 45s");
    expect(composer.sends()[0]?.runAt).toBe(new Date(NOW.getTime() + 45_000).toISOString());
  });

  test("a send later shows its time with Undo, then clears after the toast delay so other toasts show", async () => {
    const composer = fixtureComposer({ now: () => NOW, delaySeconds: 30 });
    await mount(
      { composer, timing: { collapse: 0, toast: 40 } },
      { "send.later_presets_hours": [2] },
    );
    await press("c");
    await until(() => overlay() !== null);
    const to = overlay()?.querySelector<HTMLInputElement>("#compose-to");
    if (!to) throw new Error("no To field");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(to, "aoife@northlight.dev");
      to.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      to.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    const later = [...(overlay()?.querySelectorAll<HTMLButtonElement>(".c-foot .btn") ?? [])].find(
      (b) => b.textContent?.includes("Later"),
    );
    await click(later ?? null);
    await click(document.querySelector(".pop.later .pop-item"));
    await until(() => document.querySelector("[data-send-undo]") !== null);
    const bar = document.querySelector("[data-send-undo]");
    expect(bar?.textContent).toContain("Sending Today 12:00");
    expect(bar?.querySelector(".btn")?.textContent).toContain("Undo");
    expect(composer.sends()[0]?.runAt).toBe(new Date(NOW.getTime() + 2 * 3_600_000).toISOString());
    await until(() => document.querySelector("[data-send-undo]") === null);
    expect(composer.sends()[0]?.status).toBe("scheduled");
  });

  test("Escape on a reply with unsaved text saves it instead of dropping it", async () => {
    const composer = fixtureComposer({ now: () => NOW });
    await mount({ composer, initialOpen: "e1" }, { "send.draft_autosave_ms": 60_000 });
    await press("r");
    await until(() => document.querySelector(".reply .tiptap") !== null);
    const box = document.querySelector<HTMLElement & { editor?: TiptapEditor }>(".reply .tiptap");
    if (!box?.editor) throw new Error("no editor");
    // Type through the editor (Tiptap hangs itself on its element), inside the idle window.
    const editor = box.editor;
    await act(async () => {
      editor.chain().focus("start").insertContent("Hi Aoife").run();
    });
    expect(box.textContent).toContain("Hi Aoife");
    expect(composer.drafts()).toHaveLength(0);
    await press("Escape");
    await until(() => composer.drafts().length === 1);
    expect(composer.drafts()[0]?.bodyText).toContain("Hi Aoife");
  });

  test("Z during the undo window cancels the send instead of the last triage action", async () => {
    const composer = fixtureComposer({ now: () => NOW, delaySeconds: 30 });
    await mount({ composer, initialOpen: "e1" });
    await press("r");
    await until(() => document.querySelector(".reply .tiptap") !== null);
    await click(document.querySelector(".reply-bottom .btn.primary"));
    await until(() => document.querySelector("[data-send-undo]") !== null);
    await press("z");
    await until(() => composer.sends()[0]?.status === "cancelled");
  });

  test("the bar counts down and clears once the send is on its way", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const r = root;
    let elapsed = 0;
    let t = Date.parse("2026-09-16T10:00:00Z");
    const runAt = "2026-09-16T10:00:02.000Z";
    const strings = {
      sendingIn: "Sending in {n}s",
      sendingNow: "Sending",
      scheduledFor: "Sending {when}",
      undo: "Undo",
    };
    await act(async () =>
      r.render(
        <UndoBar
          runAt={runAt}
          now={() => new Date(t)}
          strings={strings}
          onUndo={() => {}}
          onElapsed={() => {
            elapsed += 1;
          }}
          tickMs={10}
        />,
      ),
    );
    const bar = () => host?.querySelector(".toast");
    expect(bar()?.textContent).toContain("Sending in 2s");
    t += 1000;
    await until(() => bar()?.textContent?.includes("Sending in 1s") === true);
    t += 1500;
    await until(() => elapsed === 1);
    expect(bar()?.querySelector(".btn")).toBeNull();
    expect(bar()?.textContent).toBe("Sending");
  });
});

describe("attachments", () => {
  test("a failed upload says so, can be dismissed, and does not block Send", async () => {
    const composer = fixtureComposer({ now: () => NOW });
    composer.upload = async () => {
      throw new Error("Too large for this account");
    };
    await mount({ composer, initialOpen: "e1" });
    await press("r");
    await until(() => document.querySelector(".reply .tiptap") !== null);
    const input = document.querySelector<HTMLInputElement>("input[type=file]");
    if (!input) throw new Error("no file input");
    const file = new File([new Uint8Array([1, 2, 3])], "big.zip", { type: "application/zip" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await until(() => document.querySelector(".c-atts .att.failed") !== null);
    const failed = document.querySelector<HTMLElement>(".c-atts .att.failed");
    expect(failed?.textContent).toContain("Too large for this account");
    expect(document.querySelector<HTMLButtonElement>(".reply-bottom .btn.primary")?.disabled).toBe(
      false,
    );
    await click(failed?.querySelector(".x") ?? null);
    expect(document.querySelector(".c-atts .att.failed")).toBeNull();
  });

  test("an upload in flight shows its progress and a done one its size", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const r = root;
    await act(async () =>
      r.render(
        <Attachments
          attachments={[
            { blobId: "b1", name: "cv.pdf", size: 214 * 1024, mediaType: "application/pdf" },
          ]}
          uploads={[
            { key: "u1", name: "big.zip", size: 10, mediaType: "application/zip", fraction: 0.5 },
          ]}
          onRemove={() => {}}
          strings={{ uploading: "Uploading {pct}%", remove: "Remove" }}
        />,
      ),
    );
    const atts = [...document.querySelectorAll<HTMLElement>(".c-atts .att")];
    expect(atts).toHaveLength(2);
    expect(atts[0]?.textContent).toContain("cv.pdf");
    expect(atts[0]?.textContent).toContain("214 KB");
    expect(atts[1]?.textContent).toContain("Uploading 50%");
    expect(atts[1]?.querySelector<HTMLElement>(".bar")?.style.width).toBe("50%");
  });
});
