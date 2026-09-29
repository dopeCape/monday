/// <reference types="bun-types" />
// The To field through the DOM (happy-dom): the Cache's people show as soon
// as they are read, with the typed part marked; the Server's join them
// without duplicates; and the keys work as before: arrows walk, Enter, Tab
// and comma pick or make a pill, Backspace takes the last one back, and a
// pasted list becomes a pill each.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Person, PersonHit } from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import type { PeopleSource } from "../../people/lookup.ts";
import { Recipients } from "./Recipients.tsx";

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

const hit = (email: string, name: string, score: number): PersonHit => ({
  email,
  name,
  sent: 0,
  received: 0,
  lastAt: null,
  score,
});
const kenji = hit("kenji.w@meridianfund.co", "Kenji Watanabe", 5);
const kelp = hit("news@kelp.io", "Kelp Weekly", 2);
const kasia = hit("kasia@archive.example", "Kasia Nowak", 4);

interface Remote {
  q: string;
  resolve: (rows: PersonHit[]) => void;
}

function source(remote: Remote[] | null): PeopleSource {
  return {
    local: async (q) =>
      [kenji, kelp].filter(
        (p) => p.name.toLowerCase().startsWith(q.toLowerCase()) || p.email.startsWith(q),
      ),
    ...(remote
      ? {
          remote: (q: string) =>
            new Promise<PersonHit[] | null>((resolve) => remote.push({ q, resolve })),
        }
      : {}),
    limit: () => 8,
    debounceMs: () => 80,
  };
}

let picked: Person[] = [];

async function mount(src: PeopleSource) {
  picked = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  function Field() {
    const [value, setValue] = useState<Person[]>([]);
    return (
      <Recipients
        value={value}
        onChange={(people) => {
          picked = people;
          setValue(people);
        }}
        source={src}
        label="To"
      />
    );
  }
  const r = root;
  await act(async () => r.render(<Field />));
}

const input = () => {
  const el = document.querySelector<HTMLInputElement>(".to input");
  if (!el) throw new Error("no input");
  return el;
};
const wait = (ms: number) =>
  act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });

async function type(text: string) {
  const el = input();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function press(key: string) {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}
async function paste(text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
  await act(async () => {
    input().dispatchEvent(event);
  });
}

const options = () =>
  [...document.querySelectorAll<HTMLElement>(".c-suggest .pop-item")].map((o) => ({
    text: o.textContent,
    on: o.classList.contains("on"),
  }));
const pills = () => [...document.querySelectorAll(".to .pill")].map((p) => p.getAttribute("title"));

describe("the To field", () => {
  test("shows the Cache's people at once with the typed part marked, then merges the Server's", async () => {
    const remote: Remote[] = [];
    await mount(source(remote));
    await type("k");
    await wait(1);
    expect(options().map((o) => o.text)).toEqual([
      "Kenji Watanabekenji.w@meridianfund.co",
      "Kelp Weeklynews@kelp.io",
    ]);
    expect([...document.querySelectorAll(".c-suggest mark")].map((m) => m.textContent)).toContain(
      "K",
    );
    expect(remote).toHaveLength(0);
    await wait(120);
    expect(remote.map((r) => r.q)).toEqual(["k"]);
    await act(async () => remote[0]?.resolve([{ ...kenji, score: 9 }, kasia]));
    expect(options().map((o) => o.text)).toEqual([
      "Kenji Watanabekenji.w@meridianfund.co",
      "Kasia Nowakkasia@archive.example",
      "Kelp Weeklynews@kelp.io",
    ]);
  });

  test("a newer keystroke narrows at once and a late answer for an old one is ignored", async () => {
    const remote: Remote[] = [];
    await mount(source(remote));
    await type("k");
    await wait(120);
    await type("kel");
    // Before any answer for "kel": the old list, narrowed to what still matches.
    expect(options().map((o) => o.text)).toEqual(["Kelp Weeklynews@kelp.io"]);
    await act(async () => remote[0]?.resolve([kasia]));
    expect(options().map((o) => o.text)).toEqual(["Kelp Weeklynews@kelp.io"]);
  });

  test("arrows walk, Enter picks; Tab picks; comma makes a typed address a pill; Backspace takes it back", async () => {
    await mount(source(null));
    await type("k");
    await wait(1);
    expect(options().map((o) => o.on)).toEqual([true, false]);
    await press("ArrowDown");
    expect(options().map((o) => o.on)).toEqual([false, true]);
    await press("ArrowDown");
    expect(options().map((o) => o.on)).toEqual([true, false]);
    await press("ArrowUp");
    await press("Enter");
    expect(pills()).toEqual(["news@kelp.io"]);
    expect(input().value).toBe("");

    await type("ken");
    await wait(1);
    await press("Tab");
    expect(picked.map((p) => p.email)).toEqual(["news@kelp.io", "kenji.w@meridianfund.co"]);
    expect(picked[1]?.name).toBe("Kenji Watanabe");

    await type("ravi@x.dev");
    await wait(1);
    await press(",");
    expect(pills()).toEqual(["news@kelp.io", "kenji.w@meridianfund.co", "ravi@x.dev"]);

    await press("Backspace");
    expect(pills()).toEqual(["news@kelp.io", "kenji.w@meridianfund.co"]);
    // Chosen people are not suggested again.
    await type("k");
    await wait(1);
    expect(options()).toEqual([]);
  });

  test("a pasted list of addresses becomes a pill each", async () => {
    await mount(source(null));
    await paste("Ada <ada@x.io>, bo@y.dev; cy@z.org\nada@x.io");
    expect(picked).toEqual([
      { name: "Ada", email: "ada@x.io" },
      { name: "", email: "bo@y.dev" },
      { name: "", email: "cy@z.org" },
    ]);
    // A single address pastes as text, to be finished by hand.
    await paste("dee@w.io");
    expect(pills()).toHaveLength(3);
  });

  test("offline or with no Server, the Cache's people still show", async () => {
    await mount(source(null));
    await type("kel");
    await wait(120);
    expect(options().map((o) => o.text)).toEqual(["Kelp Weeklynews@kelp.io"]);
  });
});
