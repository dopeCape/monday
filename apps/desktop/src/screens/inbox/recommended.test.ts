// Recommended action chips on the Device (docs/spec/actions.md): the reader's
// one row (Custom actions first, then the meeting chips, then the Recommended
// actions, never more than max_in_reader; acceptance 7), each chip an ordinary
// tool call with its Tier (a reply, a forward or a hand-off opens compose and
// sends nothing; archive and snooze apply with Undo; acceptance 4), the chip
// keys, and the row's mode.

import { describe, expect, test } from "bun:test";
import type { Person, Recommendation } from "@monday/shared";
import { defaultSettings, recommendationWords } from "@monday/shared";
import {
  chipMenu,
  createRecommendationRunner,
  followUpUntil,
  listMode,
  readerChips,
  recommendationTier,
  recommendedKeyIndex,
  shownRecommendations,
} from "./recommended.ts";

const priya: Person = { name: "Priya Raman", email: "priya@monday.test" };
const recs: Recommendation[] = [
  { kind: "reply", fit: 0.8, rank: 0.8 },
  { kind: "archive", fit: 0.9, rank: 0.9 },
  { kind: "snooze", fit: 0.85, rank: 0.85, until: "2026-10-05T07:00:00.000Z", anchor: "weekday" },
  { kind: "forward", fit: 0.88, rank: 0.88, to: priya, confidence: 0.9 },
];
const words = recommendationWords(defaultSettings());
const now = new Date("2026-09-29T10:00:00Z");

describe("the reader's chip row", () => {
  test("never more than max_in_reader; Custom actions first, then meetings, then the likeliest", () => {
    const row = readerChips({
      custom: [{ id: "file", label: "File it", tier: "reversible" }],
      meetings: [{ kind: "offer_times", label: "Offer times" }],
      meetingMax: 2,
      recommended: recs,
      max: 3,
      words,
      now,
    });
    expect(row.map((c) => c.kind)).toEqual(["custom", "meeting", "recommended"]);
    expect(row.map((c) => c.label)).toEqual(["File it", "Offer times", "Reply"]);
    for (const max of [0, 1, 2, 3, 6]) {
      const capped = readerChips({
        custom: [],
        meetings: [],
        meetingMax: 2,
        recommended: recs,
        max,
        words,
        now,
      });
      expect(capped.length).toBe(Math.min(max, recs.length));
    }
  });
  test("shown only past each threshold and above AI level off", () => {
    const settings = { ...defaultSettings(), "ai.level": "assist" as const };
    expect(
      shownRecommendations({ settings, recommendations: recs, fromDomain: null }).map(
        (r) => r.kind,
      ),
    ).toEqual(["archive", "forward", "snooze", "reply"]);
    expect(
      shownRecommendations({
        settings: { ...settings, "ai.level": "off" },
        recommendations: recs,
        fromDomain: null,
      }),
    ).toEqual([]);
    expect(listMode(settings)).toBe("hover");
    expect(listMode({ ...settings, "actions.recommended.in_list": "always" })).toBe("always");
    expect(listMode({ ...settings, "actions.recommended.max_in_list": 0 })).toBe("off");
  });
  test("each chip's Tier: compose chips ask, archive and snooze apply with Undo", () => {
    expect(recs.map(recommendationTier)).toEqual([
      "always-ask",
      "reversible",
      "reversible",
      "always-ask",
    ]);
  });
});

describe("running a chip", () => {
  const make = () => {
    const calls: string[] = [];
    const runner = createRecommendationRunner({
      reply: (t, opening) => calls.push(`reply ${t} ${opening}`),
      forward: (t, to) => calls.push(`forward ${t} ${to.email}`),
      handOff: (t, to) => calls.push(`handoff ${t} ${to.email}`),
      archive: async (t) => {
        calls.push(`archive ${t}`);
        return "undo-1";
      },
      snooze: async (t, until) => {
        calls.push(`snooze ${t} ${until.toISOString()}`);
        return "undo-2";
      },
      pickSnooze: (t) => calls.push(`picker ${t}`),
      replyLine: () => "Thursday works for me.",
      openLink: (url) => {
        calls.push(`open ${url}`);
      },
      rsvp: async (id, response) => {
        calls.push(`rsvp ${id} ${response}`);
      },
      createEvent: async (e) => {
        calls.push(`event ${e.title} ${e.start}`);
      },
      openEditor: (e) => calls.push(`editor ${e.day}`),
      unsubscribe: (t, rec) => calls.push(`card ${t} ${rec.method}`),
      runWorkflow: async (id, t) => {
        calls.push(`workflow ${id} ${t}`);
      },
    });
    return { calls, runner };
  };
  test("a forward opens compose with the person and sends nothing; a reply carries the Brief's line", async () => {
    const { calls, runner } = make();
    expect(await runner.run(recs[3] as Recommendation, "t1")).toEqual({
      ok: true,
      applied: "compose",
    });
    await runner.run(recs[0] as Recommendation, "t1");
    await runner.run({ kind: "delegate", fit: 0.9, rank: 0.9, to: priya, confidence: 0.9 }, "t1");
    expect(calls).toEqual([
      "forward t1 priya@monday.test",
      "reply t1 Thursday works for me.",
      "handoff t1 priya@monday.test",
    ]);
  });
  test("archive and a timed snooze apply with Undo; a snooze with no time opens the picker", async () => {
    const { calls, runner } = make();
    expect(await runner.run(recs[1] as Recommendation, "t1")).toMatchObject({
      applied: "archive",
      undo: "undo-1",
    });
    const until = new Date(Date.now() + 86_400_000).toISOString();
    expect(
      await runner.run({ kind: "snooze", fit: 0.9, rank: 0.9, until, anchor: "tomorrow" }, "t1"),
    ).toMatchObject({ applied: "snooze", undo: "undo-2" });
    expect(
      await runner.run({ kind: "snooze", fit: 0.9, rank: 0.9, until: null, anchor: "none" }, "t1"),
    ).toEqual({ ok: true, applied: "picker" });
    expect(calls.at(-1)).toBe("picker t1");
  });
  test("a hand-off's follow-up comes back after the days the Setting names, at the morning hour", () => {
    const at = followUpUntil(new Date(2026, 8, 29, 15, 0), 3, 8);
    expect(at?.getDate()).toBe(2);
    expect(at?.getHours()).toBe(8);
    expect(followUpUntil(now, 0, 8)).toBeNull();
  });
});

describe("the chip keys", () => {
  const keys = ["alt+1", "alt+2", "alt+3"];
  const press = (key: string, code: string, mods: { alt?: boolean; ctrl?: boolean } = {}) =>
    recommendedKeyIndex(keys, {
      key,
      code,
      altKey: mods.alt ?? false,
      ctrlKey: mods.ctrl ?? false,
      metaKey: false,
      shiftKey: false,
    });
  test("Alt+1..3 by position, by the key or the physical digit (Option+1 types ¡ on a Mac)", () => {
    expect(press("1", "Digit1", { alt: true })).toBe(0);
    expect(press("¡", "Digit1", { alt: true })).toBe(0);
    expect(press("3", "Digit3", { alt: true })).toBe(2);
    expect(press("1", "Digit1")).toBe(-1);
    expect(press("1", "Digit1", { alt: true, ctrl: true })).toBe(-1);
    expect(press("4", "Digit4", { alt: true })).toBe(-1);
  });
});

describe("the slice 35 chips", () => {
  const make = () => {
    const calls: string[] = [];
    const runner = createRecommendationRunner({
      reply: () => calls.push("reply"),
      forward: () => calls.push("forward"),
      handOff: () => calls.push("handoff"),
      archive: async () => null,
      snooze: async (t, until) => {
        calls.push(`snooze ${t} ${until.toISOString()}`);
        return "u";
      },
      pickSnooze: (t) => calls.push(`picker ${t}`),
      replyLine: () => null,
      openLink: (url) => {
        calls.push(`open ${url}`);
      },
      rsvp: async (id, response) => {
        calls.push(`rsvp ${id} ${response}`);
      },
      createEvent: async (e) => {
        calls.push(`event ${e.title} ${e.start}`);
      },
      openEditor: (e) => calls.push(`editor ${e.day}`),
      unsubscribe: (t, rec) => calls.push(`card ${t} ${rec.method}`),
      runWorkflow: async (id, t) => {
        calls.push(`workflow ${id} ${t}`);
      },
      timeConfidence: 0.7,
    });
    return { calls, runner };
  };
  const later = new Date(Date.now() + 3 * 86_400_000).toISOString();
  test("an RSVP needs the user's answer; a timed event goes on the calendar, an unsure one opens the editor", async () => {
    const { calls, runner } = make();
    const rsvp: Recommendation = {
      kind: "rsvp",
      fit: 1,
      rank: 1,
      inviteId: "inv1",
      title: "Design review",
      start: later,
      clash: null,
    };
    expect(await runner.run(rsvp, "t1")).toEqual({ ok: false, reason: "unavailable" });
    await runner.run(rsvp, "t1", "tentative");
    const event = {
      kind: "calendar" as const,
      fit: 0.9,
      rank: 0.9,
      day: "2026-10-01",
      start: "2026-10-01T15:00:00.000Z",
      end: "2026-10-01T15:30:00.000Z",
      title: "Podcast recording",
    };
    await runner.run({ ...event, timeConfidence: 0.9 }, "t1");
    await runner.run({ ...event, timeConfidence: 0.4 }, "t1");
    expect(calls).toEqual([
      "rsvp inv1 tentative",
      "event Podcast recording 2026-10-01T15:00:00.000Z",
      "editor 2026-10-01",
    ]);
  });
  test("pay opens the page read-only, or reminds; track opens the carrier; unsubscribe shows its card; a Workflow runs", async () => {
    const { calls, runner } = make();
    const pay = {
      kind: "pay" as const,
      fit: 0.9,
      rank: 0.9,
      amount: "$1,315.50",
      value: 1315.5,
      currency: "USD",
      amountConfidence: 0.9,
      due: later,
      remindAt: later,
    };
    await runner.run(
      { ...pay, link: { url: "https://pay.hetzner.com/i/1", domain: "pay.hetzner.com" } },
      "t1",
    );
    await runner.run({ ...pay, link: null }, "t1");
    await runner.run({ ...pay, link: null, remindAt: null }, "t1");
    await runner.run(
      {
        kind: "track",
        fit: 0.9,
        rank: 0.9,
        url: "https://carrier.test/1Z",
        carrier: "ups",
        number: "1Z",
        deliveryDay: null,
      },
      "t1",
    );
    await runner.run(
      {
        kind: "unsubscribe",
        fit: 1,
        rank: 1,
        listId: "l",
        listName: "Weekly",
        method: "one_click",
        target: "https://list.test/u",
        issues: 3,
      },
      "t1",
    );
    await runner.run(
      { kind: "workflow", fit: 0.9, rank: 0.9, workflowId: "wf1", name: "Intake", confidence: 0.8 },
      "t1",
    );
    expect(calls).toEqual([
      "open https://pay.hetzner.com/i/1",
      `snooze t1 ${later}`,
      "picker t1",
      "open https://carrier.test/1Z",
      "card t1 one_click",
      "workflow wf1 t1",
    ]);
  });
  test("an RSVP is one grouped chip with its three answers; each chip's menu", () => {
    const row = readerChips({
      custom: [],
      meetings: [],
      meetingMax: 2,
      recommended: [
        {
          kind: "rsvp",
          fit: 1,
          rank: 1,
          inviteId: "i",
          title: "Sync",
          start: later,
          clash: "Planning",
        },
      ],
      max: 3,
      words,
      now,
    });
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({
      label: "Accept · Maybe · Decline",
      options: [
        { key: "accepted", label: "Accept" },
        { key: "tentative", label: "Maybe" },
        { key: "declined", label: "Decline" },
      ],
    });
    const menuWords = {
      notThis: "Not this",
      notFor: "Not for mail from {domain}",
      remindPay: "Remind me to pay",
      file: "File",
      trackSnooze: "Snooze until the delivery day",
    };
    const pay: Recommendation = {
      kind: "pay",
      fit: 0.9,
      rank: 0.9,
      amount: "$1",
      value: 1,
      currency: "USD",
      amountConfidence: 0.9,
      due: null,
      link: { url: "https://pay.stripe.com/x", domain: "pay.stripe.com" },
      remindAt: null,
    };
    expect(
      chipMenu(pay, "stripe.com", menuWords, { fileAction: true }).map((m) => m.label),
    ).toEqual(["Remind me to pay", "File", "Not this", "Not for mail from stripe.com"]);
    expect(chipMenu(recs[0] as Recommendation, null, menuWords).map((m) => m.key)).toEqual([
      "not_this",
    ]);
  });
});
