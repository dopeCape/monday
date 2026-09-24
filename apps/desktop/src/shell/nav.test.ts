/// <reference types="bun-types" />
// The navigation model: the workspace button names the owner's address with
// its initials and the connection state, the folder labels come from Settings,
// the counts come from the Inbox's unread Threads (Sub-groups roll up) with
// the Drafts and Snoozed totals beside their folders (none when empty), the
// rail lists Inbox and the Mail folders then the top-level Groups with an
// icon from the `routing.group_icons` Setting or a folder, and a Scheduled
// folder appears only while a send is scheduled. Pure functions over the shapes the App holds.

import { describe, expect, test } from "bun:test";
import { defaultSettings, type Group, type Thread } from "@monday/shared";
import { FolderSimpleIcon, ReceiptIcon, UsersThreeIcon } from "@phosphor-icons/react";
import {
  addressInitials,
  GROUP_ICON_CATALOG,
  groupIconFor,
  navModel,
  unreadCounts,
} from "./nav.ts";

const rule = { sentence: "", predicate: {}, prompt: "" };
const group = (id: string, name: string, parentId: string | null = null): Group => ({
  id,
  workspaceId: "ws",
  parentId,
  name,
  rule,
  threshold: null,
  briefPolicy: null,
});
const thread = (id: string, over: Partial<Thread>): Thread =>
  ({
    id,
    workspaceId: "ws",
    subject: id,
    participants: [],
    lastActivity: "2026-09-16T09:00:00Z",
    messageCount: 1,
    unread: true,
    starred: false,
    archived: false,
    snoozedUntil: null,
    section: "needs-reply",
    group: null,
    subgroup: null,
    tags: [],
    labels: [],
    hasAttachments: false,
    snippet: "",
    ...over,
  }) as Thread;

const groups = [
  group("hiring", "Hiring"),
  group("candidates", "Candidates", "hiring"),
  group("finance", "Finance"),
  group("ops", "Operations"),
];

describe("addressInitials", () => {
  test("the local part and the domain give two letters", () => {
    expect(addressInitials("tejas@genai-labs.io")).toBe("TG");
    expect(addressInitials("hello@monday.email")).toBe("HM");
    expect(addressInitials("Aoife Brennan")).toBe("AB");
    expect(addressInitials("")).toBe("?");
  });
});

describe("unreadCounts", () => {
  test("counts unread Threads per folder and per Group, rolling Sub-groups up", () => {
    const threads = [
      thread("a", { group: "hiring", subgroup: "candidates", starred: true }),
      thread("b", { group: "hiring" }),
      thread("c", { group: "finance", unread: false }),
      thread("d", {}),
    ];
    expect(unreadCounts(threads, groups)).toEqual({
      inbox: 3,
      starred: 1,
      hiring: 2,
      candidates: 1,
    });
  });
});

describe("groupIconFor", () => {
  test("matches the Setting's words against the id and the name, else the fallback icon", () => {
    const icon = groupIconFor(defaultSettings()["routing.group_icons"]);
    expect(icon(group("hiring", "Hiring"))).toBe(UsersThreeIcon);
    expect(icon(group("g-42", "Q3 invoices"))).toBe(ReceiptIcon);
    // Every Group carries an icon: one no word matches shows the fallback.
    expect(icon(group("ops", "Operations"))).toBe(FolderSimpleIcon);
    // Every shipped icon name is in the catalog.
    for (const name of Object.values(defaultSettings()["routing.group_icons"])) {
      expect(GROUP_ICON_CATALOG[name], name).toBeDefined();
    }
    // An icon name the catalog lacks reads as none rather than throwing.
    // An icon name the catalog does not know falls back too.
    expect(groupIconFor({ ops: "not-an-icon" })(group("ops", "Operations"))).toBe(FolderSimpleIcon);
  });
});

describe("navModel", () => {
  const strings = defaultSettings();

  test("the workspace button carries the address, its initials and the connection state", () => {
    const nav = navModel({
      address: "tejas@genai-labs.io",
      status: "online",
      threads: [],
      groups: [],
      strings,
    });
    expect(nav.workspace).toEqual({
      name: "tejas@genai-labs.io",
      initials: "TG",
      status: "Connected",
    });
    expect(
      navModel({ address: "a@b.c", status: "offline", threads: [], groups: [], strings }).workspace
        .status,
    ).toBe("Offline");
    expect(
      navModel({ address: "a@b.c", status: "syncing", threads: [], groups: [], strings }).workspace
        .status,
    ).toBe("Syncing");
  });

  test("the folders, headings and tail read from Settings and the rail lists Inbox, the folders, then the top-level Groups", () => {
    const nav = navModel({
      address: "tejas@genai-labs.io",
      status: "online",
      threads: [thread("a", { group: "hiring" })],
      groups,
      groupIcon: groupIconFor(strings["routing.group_icons"]),
      strings: { ...strings, "strings.nav.inbox": "Posteingang", "strings.nav.mail": "Post" },
    });
    expect(nav.folders.map((f) => f.key)).toEqual([
      "inbox",
      "starred",
      "snoozed",
      "drafts",
      "sent",
      "archive",
    ]);
    expect(nav.folders[0]?.label).toBe("Posteingang");
    expect(nav.labels.mail).toBe("Post");
    expect(nav.labels.settings).toBe("Settings");
    expect(nav.counts).toEqual({ inbox: 1, hiring: 1 });
    expect(nav.rail.map((r) => r.key)).toEqual([
      "inbox",
      "starred",
      "snoozed",
      "drafts",
      "sent",
      "archive",
      "hiring",
      "finance",
      "ops",
    ]);
    expect(nav.rail[0]?.title).toBe("Posteingang");
    expect(nav.rail[6]?.icon).toBe(UsersThreeIcon);
    // A Group no word matches shows the fallback folder, in the rail and the sidebar alike.
    expect(nav.rail[8]?.icon).toBe(FolderSimpleIcon);
    expect(nav.groupIcon(groups[3] as Group)).toBe(FolderSimpleIcon);
    expect(nav.railTail.map((r) => r.key)).toEqual([
      "calendar",
      "workflows",
      "routing",
      "settings",
    ]);
    expect(nav.calendar.label).toBe("Calendar");
    expect(nav.automation.map((a) => a.label)).toEqual(["Workflows", "Routing"]);
  });

  test("Drafts and Snoozed carry their totals; an empty folder shows no count, not zero", () => {
    const base = { address: "a@b.c", status: "online" as const, threads: [], groups: [], strings };
    expect(navModel({ ...base, folderCounts: { drafts: 3, snoozed: 2 } }).counts).toEqual({
      drafts: 3,
      snoozed: 2,
    });
    const empty = navModel({ ...base, folderCounts: { drafts: 0, snoozed: 0 } }).counts;
    expect("drafts" in empty).toBe(false);
    expect("snoozed" in empty).toBe(false);
  });

  test("every Section lives in the nav, whatever its placement, in Section order with its unread count; a hidden one is left out and an empty one has no count", () => {
    const nav = navModel({
      address: "a@b.c",
      status: "online",
      threads: [
        thread("a", { section: "needs-reply" }),
        thread("b", { section: "needs-reply" }),
        thread("c", { section: "reading", unread: false }),
      ],
      groups: [],
      sections: [
        ...strings["sections.rules"],
        { id: "reading", name: "Reading", when: { bulk: true }, placement: "stream" },
        { id: "secret", name: "Secret", when: {}, placement: "nav", hidden: true },
      ],
      sectionOrder: [...strings["sections.order"], "reading", "secret"],
      strings,
    });
    expect(nav.sections).toEqual([
      { key: "section:needs-reply", label: "Needs your reply" },
      { key: "section:waiting", label: "Waiting on you" },
      { key: "section:fyi", label: "For your information" },
      { key: "section:newsletters", label: "Newsletters" },
      { key: "section:reading", label: "Reading" },
    ]);
    expect(nav.counts["section:needs-reply"]).toBe(2);
    expect("section:reading" in nav.counts).toBe(false);
    expect("section:fyi" in nav.counts).toBe(false);
  });

  test("a Scheduled folder appears only while a send is scheduled", () => {
    const base = { address: "a@b.c", status: "online" as const, threads: [], groups: [], strings };
    expect(
      navModel({ ...base, scheduled: { count: 0, label: "Scheduled" } }).folders.map((f) => f.key),
    ).not.toContain("scheduled");
    const with2 = navModel({ ...base, scheduled: { count: 2, label: "Scheduled" } });
    expect(with2.folders.at(-1)).toMatchObject({ key: "scheduled", label: "Scheduled", count: 2 });
  });
});
