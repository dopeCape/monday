// Templates' code-owned parts through their interfaces: Placeholder syntax and
// validation, the built-ins, candidates from a Thread with normalization, and
// the Markdown export that Import reads back.

import { describe, expect, test } from "bun:test";
import { BUILTIN_TEMPLATES, findBuiltinTemplate, templateLibrary } from "./builtin.ts";
import { type FillThread, findCandidates, normalizeValue, otherPeople } from "./candidates.ts";
import {
  templateFileName,
  templateFromMarkdown,
  templatesFromFiles,
  templatesToFiles,
  templateToMarkdown,
} from "./markdown.ts";
import {
  fillPlaceholders,
  placeholdersIn,
  templateErrors,
  tidyTemplate,
  unfilledRequired,
} from "./syntax.ts";
import { ownWords, questionSentences, splitSentences } from "./text.ts";
import type { Template, TemplateInput } from "./types.ts";

const EM_DASH = "—";

describe("Placeholder syntax", () => {
  test("uses in order of first use, {name?} optional", () => {
    expect(placeholdersIn("Hi {first_name}, {time} on {date}. {first_name} {reason?}")).toEqual([
      { name: "first_name", optional: false },
      { name: "time", optional: false },
      { name: "date", optional: false },
      { name: "reason", optional: true },
    ]);
  });

  test("every name used is declared and every declared name used, or the Template does not save", () => {
    const base: TemplateInput = {
      name: "X",
      fitsWhen: "",
      kind: "reply",
      subject: null,
      body: "Hi {first_name}, about {topic}.",
      placeholders: [{ name: "first_name", type: "first_name", optional: false, hint: "" }],
    };
    expect(templateErrors(base)).toEqual(["{topic} is used but not declared."]);
    expect(
      templateErrors({
        ...base,
        body: "Hi {first_name}.",
        placeholders: [
          ...base.placeholders,
          { name: "topic", type: "text", optional: false, hint: "" },
        ],
      }),
    ).toEqual(["{topic} is declared but never used."]);
    expect(
      templateErrors({
        ...base,
        body: "Hi {first_name} {topic}.",
        placeholders: [
          ...base.placeholders,
          { name: "topic", type: "text", optional: true, hint: "" },
        ],
      }),
    ).toEqual(["{topic} is optional, so it is written {topic?}."]);
    expect(templateErrors({ ...base, subject: "Re" })).toContain(
      "Only a starter has a subject; a reply keeps the Thread's.",
    );
  });

  test("filling removes an unfilled optional Placeholder with the space before it and keeps a required one", () => {
    const body = "I'm going to pass on this one {reason?}. Thanks {first_name}.";
    expect(fillPlaceholders(body, { first_name: "Sofia" })).toBe(
      "I'm going to pass on this one. Thanks Sofia.",
    );
    expect(fillPlaceholders(body, { reason: "as I'm travelling", first_name: null })).toBe(
      "I'm going to pass on this one as I'm travelling. Thanks {first_name}.",
    );
    expect(unfilledRequired("Thanks {first_name} {reason?}")).toEqual(["first_name"]);
  });

  test("tidy orders Placeholders by first use and drops a reply's subject", () => {
    const tidy = tidyTemplate({
      name: " A ",
      fitsWhen: " b ",
      kind: "reply",
      subject: "ignored",
      body: "{b} then {a}\r\n",
      placeholders: [
        { name: "a", type: "text", optional: false, hint: " x " },
        { name: "b", type: "text", optional: false, hint: "y" },
      ],
    });
    expect(tidy.subject).toBeNull();
    expect(tidy.placeholders.map((p) => p.name)).toEqual(["b", "a"]);
    expect(tidy.placeholders[1]?.hint).toBe("x");
    expect(tidy.body).toBe("{b} then {a}");
  });
});

describe("the built-ins", () => {
  test("21 of them, every one valid, none with an em-dash or a signature", () => {
    expect(BUILTIN_TEMPLATES).toHaveLength(21);
    expect(new Set(BUILTIN_TEMPLATES.map((t) => t.id)).size).toBe(21);
    for (const t of BUILTIN_TEMPLATES) {
      expect(templateErrors(t), t.name).toEqual([]);
      expect(tidyTemplate(t).placeholders, t.name).toEqual(t.placeholders);
      const text = [
        t.name,
        t.fitsWhen,
        t.subject ?? "",
        t.body,
        ...t.placeholders.map((p) => p.hint),
      ];
      expect(text.join(" ").includes(EM_DASH), t.name).toBe(false);
      expect(t.workspaceId).toBeNull();
      expect(t.builtIn).toBe(t.id);
      if (t.kind === "reply") expect(t.subject).toBeNull();
    }
    expect(BUILTIN_TEMPLATES.filter((t) => t.kind === "starter").map((t) => t.name)).toEqual([
      "Introduce two people",
      "Schedule a call",
      "Checking in",
      "Ask for a refund",
      "Please remove me",
    ]);
  });

  test("Confirm the time reads as the spec's example", () => {
    expect(findBuiltinTemplate("t_confirm_time")?.body).toBe(
      "Hi {first_name},\n\n{time} on {date} works for me. I'll send an invite shortly.\n\nThanks,",
    );
  });

  test("the library: own Templates first, a copy replaces its built-in, hidden ones are left out", () => {
    const copy: Template = {
      ...(findBuiltinTemplate("t_decline") as Template),
      id: "tpl-1",
      workspaceId: "ws",
      builtIn: "t_decline",
      name: "Decline, my way",
    };
    const lib = templateLibrary([copy], ["t_thank_you"]);
    expect(lib[0]?.id).toBe("tpl-1");
    expect(lib.some((t) => t.id === "t_decline")).toBe(false);
    expect(lib.some((t) => t.id === "t_thank_you")).toBe(false);
    expect(lib).toHaveLength(20);
  });
});

const podcast: FillThread = {
  subject: "Podcast recording slot",
  owner: ["me@example.test"],
  messages: [
    {
      from: { name: "Sofia Lindqvist", email: "sofia@lindqvist.se" },
      to: [{ name: "Me", email: "me@example.test" }],
      cc: [{ name: "Ravi Menon", email: "ravi@studio.test" }],
      text: [
        "Hi,",
        "",
        "We are recording a series on people rebuilding old software categories.",
        "Would Thursday 2 October at 15:00 work for 45 minutes? If not, 3 October at 10am is free too.",
        "The studio booking is REF-8812 and the fee is $250.",
        "Details: https://studio.test/booking/8812.",
        "",
        "On Mon, 15 Sep 2026, Me <me@example.test> wrote:",
        "> Happy to talk on 9 September.",
      ].join("\n"),
    },
  ],
};

describe("candidates from the Thread", () => {
  test("dates and times are found in the text, quoted history left out, and normalized to the user's format", () => {
    expect(findCandidates("date", podcast, 8)).toEqual([
      { span: "Thursday 2 October", value: "2 October" },
      { span: "3 October", value: "3 October" },
    ]);
    expect(findCandidates("time", podcast, 8)).toEqual([
      { span: "15:00", value: "15:00" },
      { span: "10am", value: "10:00" },
    ]);
    expect(findCandidates("time", podcast, 8, { dateFormat: "MMMM d", timeFormat: "12h" })).toEqual(
      [
        { span: "15:00", value: "3:00 pm" },
        { span: "10am", value: "10:00 am" },
      ],
    );
    expect(
      findCandidates("date", podcast, 8, { dateFormat: "MMMM d", timeFormat: "24h" })[0]?.value,
    ).toBe("October 2");
  });

  test("people and names come from the headers, never the owner; first_name is the first word", () => {
    expect(otherPeople(podcast).map((p) => p.email)).toEqual([
      "sofia@lindqvist.se",
      "ravi@studio.test",
    ]);
    expect(findCandidates("first_name", podcast, 8)).toEqual([
      { span: "Sofia Lindqvist", value: "Sofia" },
      { span: "Ravi Menon", value: "Ravi" },
    ]);
    expect(findCandidates("email", podcast, 8).map((c) => c.value)).toEqual([
      "sofia@lindqvist.se",
      "ravi@studio.test",
    ]);
  });

  test("amounts, references, links, text sentences, and the cap", () => {
    expect(findCandidates("amount", podcast, 8)).toEqual([{ span: "$250", value: "$250" }]);
    expect(findCandidates("reference", podcast, 8).map((c) => c.span)).toContain("REF-8812");
    expect(findCandidates("link", podcast, 8)).toEqual([
      { span: "https://studio.test/booking/8812.", value: "https://studio.test/booking/8812" },
    ]);
    const text = findCandidates("text", podcast, 8).map((c) => c.span);
    expect(text).toContain("Would Thursday 2 October at 15:00 work for 45 minutes?");
    expect(findCandidates("text", podcast, 2)).toHaveLength(2);
  });

  test("a type with no candidates gets none", () => {
    const bare: FillThread = {
      ...podcast,
      messages: podcast.messages.map((m) => ({ ...m, text: "Hi." })),
    };
    expect(findCandidates("amount", bare, 8)).toEqual([]);
    expect(findCandidates("date", bare, 8)).toEqual([]);
  });

  test("normalizing keeps a span code cannot read", () => {
    expect(normalizeValue("date", "next Tuesday")).toBe("next Tuesday");
    expect(
      normalizeValue("date", "2026-10-03", { dateFormat: "d/M/yyyy", timeFormat: "24h" }),
    ).toBe("3/10/2026");
    expect(
      normalizeValue("date", "3 October", { dateFormat: "yyyy-MM-dd", timeFormat: "24h" }),
    ).toBe("3 October");
    expect(normalizeValue("time", "noon")).toBe("12:00");
    expect(normalizeValue("email", "Sofia@Lindqvist.SE")).toBe("sofia@lindqvist.se");
  });
});

describe("text helpers", () => {
  test("own words drop the quoted history; sentences split; questions by punctuation", () => {
    expect(ownWords("Yes.\n\nOn Tue, 1 Sep 2026, A <a@x.test> wrote:\n> old")).toBe("Yes.");
    const sentences = splitSentences("Hi Sam,\nCan you send the W-9? Also the invoice. Thanks!");
    expect(sentences).toEqual(["Hi Sam,", "Can you send the W-9?", "Also the invoice.", "Thanks!"]);
    expect(questionSentences(sentences)).toEqual(["Can you send the W-9?"]);
  });
});

describe("Markdown files", () => {
  test("every built-in round-trips through Export and Import", () => {
    const files = templatesToFiles(BUILTIN_TEMPLATES);
    expect(files).toHaveLength(21);
    expect(files[1]?.name).toBe("confirm-the-time.md");
    const back = templatesFromFiles(files);
    expect(back.errors).toEqual([]);
    expect(back.templates).toEqual(
      BUILTIN_TEMPLATES.map(({ name, fitsWhen, kind, subject, body, placeholders }) => ({
        name,
        fitsWhen,
        kind,
        subject,
        body,
        placeholders,
      })),
    );
  });

  test("the front matter holds the name, fits-when, kind and Placeholders", () => {
    const md = templateToMarkdown(findBuiltinTemplate("t_refund") as Template);
    expect(md).toContain('name: "Ask for a refund"');
    expect(md).toContain("kind: starter");
    expect(md).toContain('subject: "Refund request for order {reference}"');
    expect(md).toContain('  - {"name":"reference","type":"reference","optional":false,');
  });

  test("a broken file is named with why; other files are ignored", () => {
    const out = templatesFromFiles([
      { name: "a.md", content: "no front matter" },
      { name: "b.md", content: '---\nname: "B"\nkind: reply\nplaceholders: []\n---\nHi {who}' },
      { name: "notes.txt", content: "x" },
      {
        name: "c.md",
        content: "---\nname: C plain\nfits_when: when\nkind: reply\nplaceholders: []\n---\nHello.",
      },
    ]);
    expect(out.errors.map((e) => e.file)).toEqual(["a.md", "b.md"]);
    expect(out.errors[1]?.message).toContain("{who} is used but not declared.");
    expect(out.templates.map((t) => t.name)).toEqual(["C plain"]);
    expect(() => templateFromMarkdown("---\nname: x\n---\n")).toThrow("needs a body");
  });

  test("file names are unique", () => {
    const taken = new Set(["thanks.md"]);
    expect(templateFileName("Thanks!", taken)).toBe("thanks-2.md");
    expect(templateFileName("  ")).toBe("template.md");
  });
});

describe("double braces", () => {
  test("{{firstname}} saves as {firstname}, so a filled reply never shows a stray brace", () => {
    const tidy = tidyTemplate({
      name: "Rejection",
      fitsWhen: "A candidate follows up and there is no position",
      kind: "reply",
      subject: null,
      body: "hi {{firstname}} ,\nthanks, {{ Role? }} is closed",
      placeholders: [
        { name: "firstname", type: "first_name", optional: false, hint: "their first name" },
        { name: "role", type: "text", optional: true, hint: "the role" },
      ],
    } as TemplateInput);
    expect(tidy.body).toBe("hi {firstname} ,\nthanks, {role?} is closed");
  });
});
