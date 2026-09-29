// The new shipped Signals and Facts (slice 32; docs/spec/signals.md "The
// shipped Signals", "Facts"): the invoice's deadline is 3 October and its
// amount $1,315.50 from the fake judge's picks, put together by code; a
// Thread with no amount is never asked to pick one; a French Thread's answers
// are stored and count as Unsure for acting; the Facts reach the feed in the
// clear and the picked amount stays sealed; and the patterns and the date
// assembly on their own.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, Change, FactsChange } from "@monday/shared";
import { actionable } from "@monday/shared";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import { createIntelligence, type Intelligence } from "../src/intelligence/index.ts";
import { createFakeChat, createFakeJudge } from "../src/intelligence/runtime/fake/index.ts";
import {
  assembleDeadline,
  findAmounts,
  findLinks,
  findTracking,
  languageOf,
  mayStateDeadline,
  parseAmount,
} from "../src/intelligence/signals/facts.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const NOW = new Date("2026-09-29T12:00:00Z");
const owner = { name: "Sam Okafor", email: "sam@monday.test" };

describe("Facts on their own", () => {
  test("amounts, links and tracking numbers are found verbatim; an amount parses to a number and a currency", () => {
    const text =
      "Your invoice INV-2291 over $1,315.50 is due on 3 October. Last month: $89.00. Pay at https://pay.hetzner.com/i/2291.";
    expect(findAmounts(text, 12)).toEqual(["$1,315.50", "$89.00"]);
    expect(findAmounts("Total: 1.315,50 EUR", 12)).toEqual(["1.315,50 EUR"]);
    expect(parseAmount("$1,315.50")).toEqual({ value: 1315.5, currency: "USD" });
    expect(parseAmount("1.315,50 EUR")).toEqual({ value: 1315.5, currency: "EUR" });
    expect(parseAmount("£89")).toEqual({ value: 89, currency: "GBP" });
    expect(findLinks(text, 5)).toEqual([
      { url: "https://pay.hetzner.com/i/2291", domain: "pay.hetzner.com" },
    ]);
    expect(findTracking("Your package is on its way: 1Z999AA10123456784", 5)).toEqual([
      { carrier: "ups", number: "1Z999AA10123456784" },
    ]);
    expect(findTracking("Invoice 123456789012", 5)).toEqual([]);
    expect(
      languageOf(
        "Bonjour, pourriez-vous signer le contrat avant vendredi ? Merci beaucoup pour votre aide.",
      ),
    ).toBe("other");
    expect(
      languageOf(
        "Hi Sam, could you please sign the contract by Friday? Thanks for your help with this.",
      ),
    ).toBe("en");
    expect(mayStateDeadline("Please sign it by Friday.")).toBe(true);
    expect(mayStateDeadline("Great talking to you.")).toBe(false);
  });

  test("code puts the date together from the picked parts, counting from the Message's date", () => {
    const part = (choice: string, confidence = 0.9) => ({ choice, confidence });
    // Written Tuesday 29 September 2026.
    const written = "2026-09-29T09:00:00.000Z";
    expect(
      assembleDeadline(
        { form: part("absolute"), month: part("october"), day: part("3"), year: part("none") },
        written,
        "",
        0.6,
      ),
    ).toMatchObject({ at: "2026-10-03T23:59:00.000Z", unclear: false });
    expect(
      assembleDeadline(
        {
          form: part("relative"),
          anchor: part("weekday"),
          weekday: part("friday"),
          week: part("this"),
        },
        written,
        "",
        0.6,
      ).at,
    ).toBe("2026-10-02T23:59:00.000Z");
    expect(
      assembleDeadline(
        { form: part("relative"), anchor: part("tomorrow"), hour: part("17") },
        written,
        "Europe/Dublin",
        0.6,
      ).at,
    ).toBe("2026-09-30T16:00:00.000Z");
    // 31 February makes no date; an unsure part makes it unclear, never guessed.
    expect(
      assembleDeadline(
        { form: part("absolute"), month: part("february"), day: part("31"), year: part("2027") },
        written,
        "",
        0.6,
      ),
    ).toMatchObject({ at: null, unclear: true });
    expect(
      assembleDeadline(
        { form: part("absolute"), month: part("october", 0.4), day: part("3") },
        written,
        "",
        0.6,
      ),
    ).toMatchObject({ at: null, unclear: true });
    expect(assembleDeadline({ form: part("none") }, written, "", 0.6)).toMatchObject({
      at: null,
      unclear: false,
    });
    // A date that has passed when written, with no year, is next year's.
    expect(
      assembleDeadline(
        { form: part("absolute"), month: part("january"), day: part("15"), year: part("none") },
        written,
        "",
        0.6,
      ).at,
    ).toBe("2027-01-15T23:59:00.000Z");
  });
});

describe("the new shipped Signals over the Store", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let workspaceId: string;
  const judge = createFakeJudge();
  let intelligence: Intelligence;

  const subjectOf = (state: unknown) =>
    (state as { thread?: { subject?: string } }).thread?.subject ?? "";
  const addThread = async (
    key: string,
    subject: string,
    from: { name: string; email: string },
    text: string,
  ) => {
    const threadId = await store.upsertThread({
      workspaceId,
      providerThreadId: key,
      subject,
      participants: [from, owner],
      lastActivity: "2026-09-29T09:00:00.000Z",
    });
    await store.upsertMessage({
      threadId,
      providerMessageId: `m-${key}`,
      from,
      to: [owner],
      cc: [],
      date: "2026-09-29T09:00:00.000Z",
      headers: {},
      bodyText: text,
      bodyHtml: null,
      snippet: text.slice(0, 60),
    });
    return threadId;
  };

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    const account: Account = {
      id: "acct-facts",
      provider: "jmap",
      address: owner.email,
      displayName: owner.name,
      capabilities: {
        push: true,
        labels: false,
        snooze: false,
        mute: false,
        calendar: false,
        meetingLink: null,
      },
    };
    workspaceId = (await store.createWorkspace(account)).id;
    judge.when((state) => subjectOf(state) === "Invoice INV-2291 for September", {
      money_involved: 0.96,
      money_amount: "$1,315.50",
      money_direction: "owner_pays",
      has_deadline: 0.93,
      deadline_form: "absolute",
      deadline_month: "october",
      deadline_day: "3",
      deadline_year: "none",
      deadline_hour: "none",
      automated: 0.8,
    });
    intelligence = createIntelligence({
      level: async () => "automate",
      db: db.handle.db,
      mailstore: store,
      chat: createFakeChat("{}").chat,
      judge: judge.judge,
      keys: async (provider) => (provider === "typesafe" ? "ts-key" : null),
      now: () => NOW,
    });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  test("the fixture invoice: deadline 3 October and $1,315.50 from the judge's picks, the span sealed", async () => {
    const invoice = await addThread(
      "invoice",
      "Invoice INV-2291 for September",
      { name: "Hetzner Billing", email: "billing@hetzner.com" },
      "Dear customer, your invoice INV-2291 over $1,315.50 is due on 3 October. Last month you paid $89.00.",
    );
    const before = judge.calls.length;
    await intelligence.signals.ask(workspaceId, invoice, { reason: "arrival" });
    const sent = judge.calls.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.questions).toEqual(
      expect.arrayContaining([
        "money_amount",
        "deadline_form",
        "deadline_year",
        "frustrated",
        "they_promised",
        "personal",
      ]),
    );
    const explained = await intelligence.signals.explain(invoice);
    expect(explained?.amount).toEqual({ span: "$1,315.50", value: 1315.5, currency: "USD" });
    expect(explained?.facts).toMatchObject({
      deadline_at: "2026-10-03T23:59:00.000Z",
      deadline_unclear: false,
      amount_count: 2,
      from_domain: "hetzner.com",
      to_me_directly: true,
      language: "en",
    });
    const amount = explained?.signals.find((s) => s.id === "money_amount");
    // The answer keeps whether an amount was picked; the span itself stays sealed.
    expect(amount?.choice).toBe("picked");
    const row = await db.handle.db.query.threadFacts.findFirst({
      where: (t, { eq }) => eq(t.threadId, invoice),
    });
    expect(JSON.stringify(row?.facts)).not.toContain("1,315.50");
    expect(row?.deadlineAt?.toISOString()).toBe("2026-10-03T23:59:00.000Z");
    const changes = (await store.listChanges(workspaceId, { since: 0, limit: 1000 }))
      .changes as Change[];
    const facts = changes.find((c) => c.kind === "facts" && c.entityId === invoice)
      ?.payload as FactsChange;
    expect(facts.facts.deadline_at).toBe("2026-10-03T23:59:00.000Z");
    expect(JSON.stringify(changes.filter((c) => c.entityId === invoice))).not.toContain("1,315.50");
  });

  test("a Thread with no amount is never asked to pick one; its date parts wait for a date too", async () => {
    const hello = await addThread(
      "hello",
      "Lunch",
      { name: "Ana", email: "ana@friend.test" },
      "Great seeing you yesterday.",
    );
    const before = judge.calls.length;
    await intelligence.signals.ask(workspaceId, hello, { reason: "arrival" });
    const asked = judge.calls.slice(before)[0]?.questions ?? [];
    expect(asked).not.toContain("money_amount");
    expect(asked).not.toContain("deadline_form");
    expect(asked).toContain("money_involved");
    const explained = await intelligence.signals.explain(hello);
    expect(explained?.signals.find((s) => s.id === "money_amount")).toMatchObject({
      choice: "none",
      model: "code",
    });
    expect(explained?.amount).toBeNull();
    // Nothing is missing for this Thread version: it is not asked again.
    expect(await intelligence.signals.missing(workspaceId, hello)).toEqual([]);
  });

  test("a French Thread's answers are stored and count as Unsure for acting", async () => {
    const french = await addThread(
      "french",
      "Contrat",
      { name: "Claire", email: "claire@client.fr" },
      "Bonjour Sam, pourriez-vous signer le contrat avant vendredi ? Merci beaucoup pour votre aide et votre patience.",
    );
    await intelligence.signals.ask(workspaceId, french, { reason: "arrival" });
    const readings = (await intelligence.signals.readings([french])).get(french) ?? {};
    expect(readings.waiting_on_me).toBeDefined();
    expect(readings.waiting_on_me?.lowTrust).toBe("not_english");
    expect(actionable(readings.waiting_on_me)).toBe(false);
    expect(actionable(readings.waiting_on_me, { nonEnglish: "trust" })).toBe(true);
  });

  test("the Signals page lists every active Signal with its reach and wording", async () => {
    const page = await intelligence.signals.page(workspaceId);
    const money = page.signals.find((s) => s.id === "money_involved");
    expect(money).toMatchObject({
      kind: "noul",
      version: 1,
      read: 3,
      setting: "signals.questions.money_involved",
    });
    expect(page.signals.find((s) => s.id === "deadline_day")?.kind).toBe("choice");
    expect(page.total).toBe(3);
    // The Agent's tools read the Signals too.
    const listed = await intelligence.agent
      .tools(workspaceId)
      .call(
        { name: "list_judgments", args: {}, callId: "c-1", sessionId: "s-1" },
        { ask: async () => "approved" as const },
      );
    expect(listed.isError).toBe(false);
    expect(listed.text).toContain(
      "money_involved (noul, version 1, signals.questions.money_involved)",
    );
  });
});
