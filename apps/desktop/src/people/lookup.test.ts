/// <reference types="bun-types" />
// The people lookup (lookup.ts): the Cache's answer at once, the Server's
// merged after the pause without duplicates, stale answers ignored, and the
// Cache alone offline or with no Server.

import { describe, expect, test } from "bun:test";
import type { PersonHit } from "@monday/shared";
import { highlightSpans } from "./highlight.ts";
import {
  createPeopleLookup,
  listSource,
  type PeopleResult,
  type PeopleSource,
  withList,
} from "./lookup.ts";

const hit = (email: string, name: string, score: number): PersonHit => ({
  email,
  name,
  sent: 0,
  received: 0,
  lastAt: null,
  score,
});

const kenjiLocal = hit("kenji.w@meridianfund.co", "Kenji", 2);
const kelpLocal = hit("news@kelp.io", "Kelp Weekly", 1);
const kenjiServer = hit("kenji.w@meridianfund.co", "Kenji Watanabe", 9);
const oldFriend = hit("kasia@archive.example", "Kasia Nowak", 5);

const tick = (ms = 1) => new Promise<void>((r) => setTimeout(r, ms));

interface Pending {
  q: string;
  signal: AbortSignal;
  resolve: (rows: PersonHit[] | null) => void;
  reject: (e: Error) => void;
}

/** A source whose Server answers only when the test says so. */
function scripted(local: PersonHit[], debounceMs = 20) {
  const asked: Pending[] = [];
  const source: PeopleSource = {
    local: async (q) =>
      local.filter((p) => p.name.toLowerCase().startsWith(q) || p.email.startsWith(q)),
    remote: (q, _limit, signal) =>
      new Promise((resolve, reject) => asked.push({ q, signal, resolve, reject })),
    limit: () => 8,
    debounceMs: () => debounceMs,
  };
  return { source, asked };
}

function collect() {
  const seen: PeopleResult[] = [];
  return { seen, on: (r: PeopleResult) => seen.push(r) };
}

describe("the people lookup", () => {
  test("shows the Cache's matches at once, then merges the Server's without duplicates", async () => {
    const { source, asked } = scripted([kenjiLocal, kelpLocal]);
    const lookup = createPeopleLookup(source);
    const { seen, on } = collect();
    lookup.query("k", [], on);
    await tick();
    expect(seen.at(-1)).toEqual({ query: "k", people: [kenjiLocal, kelpLocal], complete: false });
    expect(asked).toHaveLength(0);
    await tick(30);
    expect(asked.map((a) => a.q)).toEqual(["k"]);
    asked[0]?.resolve([kenjiServer, oldFriend]);
    await tick();
    const last = seen.at(-1);
    expect(last?.complete).toBe(true);
    // Kenji once, with the Server's name and score; the old friend from outside the Cache joins.
    expect(last?.people.map((p) => [p.email, p.name])).toEqual([
      ["kenji.w@meridianfund.co", "Kenji Watanabe"],
      ["kasia@archive.example", "Kasia Nowak"],
      ["news@kelp.io", "Kelp Weekly"],
    ]);
  });

  test("the chosen are left out, and the list stops at the limit", async () => {
    const { source, asked } = scripted([kenjiLocal, kelpLocal]);
    const lookup = createPeopleLookup({ ...source, limit: () => 1 });
    const { seen, on } = collect();
    lookup.query("k", [{ name: "", email: "KENJI.W@meridianfund.co" }], on);
    await tick(30);
    asked[0]?.resolve([kenjiServer, oldFriend]);
    await tick();
    expect(seen.at(-1)?.people.map((p) => p.email)).toEqual(["kasia@archive.example"]);
  });

  test("typing on asks the Server once after the pause, aborts the old request and ignores its answer", async () => {
    const { source, asked } = scripted([kenjiLocal, kelpLocal]);
    const lookup = createPeopleLookup(source);
    const { seen, on } = collect();
    lookup.query("k", [], on);
    await tick(30);
    expect(asked.map((a) => a.q)).toEqual(["k"]);
    // Keystrokes inside the pause never reach the Server.
    lookup.query("ke", [], on);
    await tick(5);
    lookup.query("ken", [], on);
    await tick(30);
    expect(asked.map((a) => a.q)).toEqual(["k", "ken"]);
    expect(asked[0]?.signal.aborted).toBe(true);
    // The stale answer lands late: nothing changes.
    const before = seen.length;
    asked[0]?.resolve([oldFriend]);
    await tick();
    expect(seen.length).toBe(before);
    asked[1]?.resolve([kenjiServer]);
    await tick();
    expect(seen.at(-1)).toMatchObject({ query: "ken", complete: true });
    expect(seen.at(-1)?.people.map((p) => p.email)).toEqual(["kenji.w@meridianfund.co"]);
    expect(seen.every((r) => !r.people.some((p) => p.email === oldFriend.email))).toBe(true);
  });

  test("offline, the Cache's answer stands", async () => {
    const { source, asked } = scripted([kenjiLocal]);
    const lookup = createPeopleLookup(source);
    const { seen, on } = collect();
    lookup.query("ken", [], on);
    await tick(30);
    asked[0]?.reject(new Error("connection refused"));
    await tick();
    expect(seen.at(-1)).toEqual({ query: "ken", people: [kenjiLocal], complete: true });
  });

  test("with no Server, or the Setting off, only the Cache answers", async () => {
    const lookup = createPeopleLookup({
      local: async () => [kenjiLocal],
      limit: () => 8,
      debounceMs: () => 0,
    });
    const { seen, on } = collect();
    lookup.query("ken", [], on);
    await tick();
    expect(seen).toEqual([{ query: "ken", people: [kenjiLocal], complete: true }]);

    const off = createPeopleLookup({
      local: async () => [kenjiLocal],
      remote: async () => null,
      limit: () => 8,
      debounceMs: () => 0,
    });
    const second = collect();
    off.query("ken", [], second.on);
    await tick(5);
    expect(second.seen.at(-1)).toEqual({ query: "ken", people: [kenjiLocal], complete: true });
  });

  test("an empty query answers empty and asks nothing", async () => {
    const { source, asked } = scripted([kenjiLocal]);
    const { seen, on } = collect();
    createPeopleLookup(source).query("  ", [], on);
    await tick(30);
    expect(seen).toEqual([{ query: "  ", people: [], complete: true }]);
    expect(asked).toHaveLength(0);
  });

  test("a list source matches words and parts in list order", async () => {
    const source = listSource(() => [
      { name: "Kenji Watanabe", email: "kenji.w@meridianfund.co" },
      { name: "Aoife Brennan", email: "aoife@northlight.dev" },
    ]);
    expect((await source.local("wat", 8)).map((p) => p.email)).toEqual(["kenji.w@meridianfund.co"]);
    expect((await source.local("northl", 8)).map((p) => p.email)).toEqual(["aoife@northlight.dev"]);
    expect(await source.local("ridian", 8)).toEqual([]);
  });

  test("a list folded in adds the people the index did not find, after its own", async () => {
    const folded = withList(
      { local: async () => [kenjiLocal], limit: () => 8, debounceMs: () => 0 },
      () => [
        { name: "Kenji", email: "KENJI.W@meridianfund.co" },
        { name: "Kirsten Guest", email: "kirsten@events.example" },
      ],
    );
    expect((await folded.local("k", 8)).map((p) => p.email)).toEqual([
      "kenji.w@meridianfund.co",
      "kirsten@events.example",
    ]);
  });

  test("the typed part is marked at the start of a word", () => {
    const marked = (text: string, q: string) =>
      highlightSpans(text, q)
        .map((s) => (s.hit ? `[${s.text}]` : s.text))
        .join("");
    expect(marked("Kenji Watanabe", "ken wat")).toBe("[Ken]ji [Wat]anabe");
    expect(marked("kenji.w@meridianfund.co", "meri")).toBe("kenji.w@[meri]dianfund.co");
    expect(marked("kenji.w@meridianfund.co", "kenji.w@m")).toBe("[kenji.w@m]eridianfund.co");
    expect(marked("Anna Adams", "a")).toBe("[A]nna Adams");
    expect(marked("Bob", "zz")).toBe("Bob");
  });
});
