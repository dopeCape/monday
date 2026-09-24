/// <reference types="bun-types" />
// Navigation through the App with happy-dom: Starred, Snoozed, Sent and
// Archive render the stream over their folder (its name, its own empty line,
// no Section headings, the wake time on a snoozed row); Drafts lists the open
// Drafts, opens the composer on one and deletes with an undo toast; each
// folder marks its nav or rail item, carries a count where one means
// something, and titles the window. The workspace button opens the switcher:
// every Account with the current one checked, Escape and a click outside
// close it with the focus back on the button, picking another writes
// workspace.current, and "Add an account" opens Settings › Accounts. Search
// stays on a stream lens and brings a page back to the Inbox; the agent bar
// on a page opens the agent there without leaving it.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { type Draft, defaultSettings, type PartialSettings } from "@monday/shared";
import { draft, threads } from "@monday/ui/fixtures";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { App } from "../App.tsx";
import type { AccountView } from "../platform/api.ts";
import { fixtureCalendar } from "../screens/calendar/calendar-data.ts";
import { fixtureComposer } from "../screens/compose/composer.ts";
import { fixtureInbox, type Inbox } from "../screens/inbox/actions.ts";
import { paletteNavigation } from "../screens/Palette.tsx";
import { StaticShell, useShell } from "./Shell.tsx";

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

const NOW = new Date("2026-09-16T10:00:00");
const settle = () => act(async () => Bun.sleep(20));
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const qa = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
const rowIds = () => qa(".col.list [data-thread]").map((r) => r.getAttribute("data-thread"));
const listTitle = () => q(".col.list .col-head h2")?.textContent;

async function click(el: Element | null | undefined) {
  if (!el) throw new Error("nothing to click");
  await act(async () => (el as HTMLElement).click());
  await settle();
}
function navItem(label: string): HTMLElement {
  const el = qa(".nav .nav-item").find(
    (b) => b.querySelector("span")?.textContent?.trim() === label,
  );
  if (!el) throw new Error(`no nav item ${label}`);
  return el;
}
async function key(target: Element | null, k: string) {
  await act(async () => {
    target?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
  await settle();
}

let captured: ReturnType<typeof useShell> | null = null;
function Capture() {
  captured = useShell();
  return null;
}

const account = (id: string, address: string, provider: AccountView["provider"]): AccountView => ({
  id,
  workspaceId: `ws-${id}`,
  provider,
  address,
  displayName: address,
  capabilities: {
    push: true,
    labels: false,
    snooze: false,
    mute: false,
    calendar: false,
    meetingLink: null,
  },
  connected: true,
  lastSync: "2026-09-16T09:58:00",
  lastError: null,
});
// The current Workspace in tests is the design fixture's (acct-genai).
const genai = account("acct-genai", "tejas@genai-labs.io", "gmail");
const hey = account("acct-hey", "tejas@hey.com", "jmap");

const emptyDraft: Draft = {
  ...draft,
  id: "d2",
  threadId: null,
  to: [],
  subject: "",
  updatedAt: "2026-09-16T09:59:00",
};

interface MountOptions {
  settings?: PartialSettings;
  accounts?: AccountView[] | null;
  inbox?: Inbox;
  drafts?: Draft[];
  calendar?: boolean;
}

async function mount(options: MountOptions = {}) {
  const accounts = options.accounts ?? null;
  const done = Object.fromEntries(
    (accounts ?? []).map((a) => [a.id, { status: "completed" as const, at: NOW.toISOString() }]),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  const inbox = options.inbox ?? fixtureInbox();
  const composer = fixtureComposer({ drafts: options.drafts ?? [], now: () => NOW });
  await act(async () =>
    r.render(
      <StaticShell settings={{ "onboarding.state": done, ...options.settings }}>
        <Capture />
        <App
          inbox={inbox}
          composer={composer}
          agentClient={null}
          accounts={accounts ? { list: async () => ({ accounts }) } : null}
          keys={null}
          now={NOW}
          calendar={options.calendar ? fixtureCalendar({}) : undefined}
        />
      </StaticShell>,
    ),
  );
  await settle();
  return { inbox, composer };
}

describe("the Mail folders", () => {
  test("Starred is the stream over starred Threads: its name, its item marked, the window titled, no Section headings", async () => {
    await mount();
    expect(listTitle()).toBe("Inbox");
    await click(navItem("Starred"));
    expect(listTitle()).toBe("Starred");
    expect(rowIds()).toEqual(threads.filter((t) => t.starred).map((t) => t.id));
    expect(qa(".col.list .sec")).toEqual([]);
    expect(q(".nav .nav-item.on")?.textContent).toContain("Starred");
    expect(q('.nav .nav-item[aria-current="page"]')?.textContent).toContain("Starred");
    expect(document.title).toBe("Starred · monday");
  });

  test("an empty folder says so in its own words and shows no count", async () => {
    await mount();
    expect(navItem("Sent").querySelector(".n")).toBeNull();
    await click(navItem("Sent"));
    expect(listTitle()).toBe("Sent");
    expect(rowIds()).toEqual([]);
    expect(q(".col.list .empty-line")?.textContent).toBe("Nothing sent yet");
    await click(navItem("Starred"));
    await click(navItem("Archive"));
    expect(q(".col.list .empty-line")?.textContent).toBe("Nothing archived yet");
  });

  test("Archive holds what was archived; Snoozed counts in the nav and says when each row wakes", async () => {
    const inbox = fixtureInbox();
    await inbox.archive(["e4"]);
    await inbox.snooze(["e5"], new Date("2026-09-17T08:00:00"));
    await mount({ inbox });
    expect(navItem("Snoozed").querySelector(".n")?.textContent).toBe("1");
    expect(rowIds()).not.toContain("e4");
    await click(navItem("Archive"));
    expect(rowIds()).toEqual(["e4"]);
    await click(navItem("Snoozed"));
    expect(rowIds()).toEqual(["e5"]);
    expect(q('.col.list [data-thread="e5"] .snip')?.textContent).toStartWith(
      "Wakes Tomorrow 08:00",
    );
    expect(document.title).toBe("Snoozed · monday");
    // Back in the Inbox, the Inbox's rows and title.
    await click(navItem("Inbox"));
    expect(listTitle()).toBe("Inbox");
    expect(rowIds()).not.toContain("e5");
  });

  test("the rail reaches the folders too and marks the one open", async () => {
    await mount({ settings: { "layout.nav": "rail" } });
    const archive = q('.rail button[aria-label="Archive"]');
    await click(archive);
    expect(listTitle()).toBe("Archive");
    expect(q('.rail button[aria-label="Archive"]')?.getAttribute("aria-current")).toBe("page");
    expect(document.title).toBe("Archive · monday");
  });

  test("the palette lists every folder as a folder:* target", () => {
    const targets = paletteNavigation(defaultSettings(), false, []).map((n) => n.target);
    for (const f of ["starred", "snoozed", "drafts", "sent", "archive"]) {
      expect(targets).toContain(`folder:${f}`);
    }
  });
});

describe("Sections in the nav", () => {
  test("every Section is a nav entry under Groups; clicking one opens the Inbox's lens on it under its name", async () => {
    const inbox = fixtureInbox();
    await mount({ inbox });
    const sections = qa(".nav .nav-item").filter((b) =>
      ["Needs your reply", "Waiting on you", "For your information", "Newsletters"].includes(
        b.querySelector("span")?.textContent ?? "",
      ),
    );
    expect(sections).toHaveLength(4);
    await click(navItem("Needs your reply"));
    expect(listTitle()).toBe("Needs your reply");
    expect(rowIds()).toEqual(
      inbox
        .threads()
        .filter((t) => t.section === "needs-reply")
        .map((t) => t.id),
    );
    expect(document.title).toBe("Needs your reply · monday");
  });
});

describe("Drafts", () => {
  test("lists the open Drafts with their count, words what is missing, and opens the composer on one", async () => {
    await mount({ drafts: [draft, emptyDraft] });
    expect(navItem("Drafts").querySelector(".n")?.textContent).toBe("2");
    await click(navItem("Drafts"));
    expect(document.title).toBe("Drafts · monday");
    expect(qa(".draft-row").map((r) => r.getAttribute("data-draft"))).toEqual(["d2", "d1"]);
    const empty = q('.draft-row[data-draft="d2"]');
    expect(empty?.textContent).toContain("No recipient");
    expect(empty?.textContent).toContain("No subject");
    const full = q('.draft-row[data-draft="d1"]');
    expect(full?.textContent).toContain("Kenji Watanabe");
    expect(full?.textContent).toContain("Re: Term sheet redline, v3");
    expect(full?.querySelector(".when")?.textContent).toBe("09:58");

    await click(q('.draft-row[data-draft="d1"] .draft-open'));
    expect(listTitle()).toBe("Inbox");
    expect(q(".compose")).not.toBeNull();
  });

  test("a row's delete removes the Draft with an undo toast, and Undo saves it back", async () => {
    const { composer } = await mount({ drafts: [draft, emptyDraft] });
    await click(navItem("Drafts"));
    await click(q('.draft-row[data-draft="d2"] .btn'));
    expect(qa(".draft-row").map((r) => r.getAttribute("data-draft"))).toEqual(["d1"]);
    expect(q(".toast")?.textContent).toContain("Draft deleted");
    expect(navItem("Drafts").querySelector(".n")?.textContent).toBe("1");
    await click(q(".toast .btn"));
    expect(qa(".draft-row").map((r) => r.getAttribute("data-draft"))).toContain("d2");
    expect(composer.draft("d2")?.subject).toBe("");
  });

  test("no Drafts shows the empty line and no count", async () => {
    await mount();
    expect(navItem("Drafts").querySelector(".n")).toBeNull();
    await click(navItem("Drafts"));
    expect(q(".empty-line")?.textContent).toBe("No drafts");
  });
});

describe("the workspace switcher", () => {
  test("lists every Account with its sync state and the current one checked; Escape closes it back onto the button", async () => {
    await mount({ accounts: [genai, hey] });
    const button = q(".nav .ws");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    await click(button);
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    const rows = qa(".ws-menu .ws-acct");
    expect(rows.map((r) => r.getAttribute("data-account"))).toEqual(["acct-genai", "acct-hey"]);
    expect(rows[0]?.getAttribute("aria-checked")).toBe("true");
    expect(rows[1]?.getAttribute("aria-checked")).toBe("false");
    expect(rows[0]?.textContent).toContain("tejas@genai-labs.io");
    expect(rows[0]?.textContent).toContain("Connected");
    expect(rows[1]?.textContent).toContain("Synced");
    expect(rows[1]?.querySelector(".lg")?.textContent).toBe("FM");
    expect(document.activeElement).toBe(rows[0] as Element);
    expect(q(".ws-menu")?.textContent).toContain("Add an account");
    expect(q(".ws-menu")?.textContent).toContain("Settings");

    await key(document.activeElement, "Escape");
    expect(q(".ws-menu")).toBeNull();
    expect(document.activeElement).toBe(button as Element);
  });

  test("an Account whose sign-in was refused says so in the switcher and on the main screen", async () => {
    const refused = {
      ...hey,
      lastError: "token endpoint: invalid_grant (reauth related error (invalid_rapt))",
      needsSignIn: true,
    };
    await mount({ accounts: [genai, refused] });
    const notice = q(".reauth-notice");
    expect(notice?.textContent).toContain(`stopped accepting monday's sign-in for ${hey.address}`);
    await click(q(".nav .ws"));
    const rows = qa(".ws-menu .ws-acct");
    expect(rows[1]?.textContent).toContain("Sign in again");
    await key(document.activeElement, "Escape");
    // Sign in again goes to Accounts, where Reconnect waits; Later hides the notice.
    const signIn = [...(notice?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "Sign in again",
    );
    await click(signIn ?? null);
    expect(document.title).toContain("Settings");
    expect(q(".reauth-notice")).toBeNull();
  });

  test("a click outside closes it; a click on the button toggles it", async () => {
    await mount({ accounts: [genai, hey] });
    await click(q(".nav .ws"));
    expect(q(".ws-menu")).not.toBeNull();
    await act(async () => {
      q(".col.list")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await settle();
    expect(q(".ws-menu")).toBeNull();
    await click(q(".nav .ws"));
    await click(q(".nav .ws"));
    expect(q(".ws-menu")).toBeNull();
  });

  test("picking another Account writes workspace.current; picking the current one changes nothing", async () => {
    await mount({ accounts: [genai, hey] });
    await click(q(".nav .ws"));
    await click(q('.ws-menu .ws-acct[data-account="acct-genai"]'));
    expect(q(".ws-menu")).toBeNull();
    expect(captured?.settings["workspace.current"]).toBe("");
    await click(q(".nav .ws"));
    await click(q('.ws-menu .ws-acct[data-account="acct-hey"]'));
    expect(captured?.settings["workspace.current"]).toBe("acct-hey");
  });

  test("Add an account opens Settings on Accounts; Settings opens Settings", async () => {
    await mount({ accounts: [genai] });
    await click(q(".nav .ws"));
    // One Account: the switcher still opens, with that one checked.
    expect(qa(".ws-menu .ws-acct")).toHaveLength(1);
    const add = qa(".ws-menu .pop-item").find((b) => b.textContent === "Add an account");
    await click(add);
    expect(q(".settings-in")?.getAttribute("data-section")).toBe("accounts");
    expect(document.title).toBe("Settings · monday");
  });

  test("the rail's avatar opens it too", async () => {
    await mount({ accounts: [genai, hey], settings: { "layout.nav": "rail" } });
    await click(q(".rail .rail-ws"));
    expect(qa(".rail .ws-menu .ws-acct")).toHaveLength(2);
  });
});

describe("search and the agent stay where the user is", () => {
  test("Search on a folder keeps the folder; on a page it comes back to the Inbox", async () => {
    await mount({ calendar: true });
    await click(navItem("Starred"));
    await click(navItem("Search"));
    expect(listTitle()).toBe("Starred");
    await click(navItem("Calendar"));
    expect(document.title).toBe("Calendar · monday");
    await click(navItem("Search"));
    expect(listTitle()).toBe("Inbox");
  });

  test("focusing the agent bar on the Calendar opens the agent there, without going to the Inbox", async () => {
    await mount({ calendar: true, settings: { "ai.level": "assist" } });
    await click(navItem("Calendar"));
    expect(document.title).toBe("Calendar · monday");
    expect(q(".agent-panel")).toBeNull();
    const input = q<HTMLTextAreaElement>(".agent-dock .agent-bar textarea");
    await act(async () => input?.focus());
    await settle();
    expect(q(".agent-panel")).not.toBeNull();
    expect(document.title).toBe("Calendar · monday");
    expect(q(".col.list")).toBeNull();
    expect(q('.nav .nav-item[aria-current="page"]')?.textContent).toContain("Calendar");
  });
});
