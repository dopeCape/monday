// The operator parser and the compiler, pure and through their interface.

import { describe, expect, test } from "bun:test";
import {
  compileQuery,
  complete,
  emptyQuery,
  hasBodyTerms,
  hasOperator,
  isEmpty,
  OPERATORS,
  parseAbsoluteDate,
  parseQuery,
  parseRelativeSpan,
} from "./query.ts";

const NOW = new Date(2026, 8, 16, 10, 0, 0);
const parse = (text: string) => parseQuery(text, { now: NOW });
const iso = (y: number, m: number, d: number) => new Date(y, m - 1, d).toISOString();

describe("parser: operators", () => {
  test("bare words and quoted phrases", () => {
    const q = parse('take-home "pro-rata clause" rust');
    expect(q.words).toEqual([
      { text: "take-home", negated: false },
      { text: "rust", negated: false },
    ]);
    expect(q.phrases).toEqual([{ text: "pro-rata clause", negated: false }]);
    expect(hasOperator(q)).toBe(true);
    expect(hasBodyTerms(q)).toBe(true);
  });

  test("from, to and subject, including quoted values", () => {
    const q = parse('from:kenji to:me subject:"term sheet" subject:v3');
    expect(q.from).toEqual([{ text: "kenji", negated: false }]);
    expect(q.to).toEqual([{ text: "me", negated: false }]);
    expect(q.subject).toEqual([
      { text: "term sheet", negated: false },
      { text: "v3", negated: false },
    ]);
    expect(q.words).toEqual([]);
    expect(hasBodyTerms(q)).toBe(false);
  });

  test("has:attachment, is:unread, is:read, is:starred, is:unstarred", () => {
    expect(parse("has:attachment").hasAttachment).toBe(true);
    expect(parse("has:attachments").hasAttachment).toBe(true);
    expect(parse("is:unread").unread).toBe(true);
    expect(parse("is:read").unread).toBe(false);
    expect(parse("is:starred").starred).toBe(true);
    expect(parse("is:unstarred").starred).toBe(false);
    expect(parse("IS:Unread HAS:Attachment").unread).toBe(true);
  });

  test("in, tag and label", () => {
    const q = parse("in:hiring tag:candidate label:inbox in:candidates");
    expect(q.group.map((c) => c.text)).toEqual(["hiring", "candidates"]);
    expect(q.tags).toEqual([{ text: "candidate", negated: false }]);
    expect(q.labels).toEqual([{ text: "inbox", negated: false }]);
  });

  test("before and after with absolute dates in three shapes", () => {
    expect(parse("before:2026-09-01").before).toBe(iso(2026, 9, 1));
    expect(parse("after:2026/08/15").after).toBe(iso(2026, 8, 15));
    expect(parse("after:2026-08").after).toBe(iso(2026, 8, 1));
    expect(parse("after:2025").after).toBe(iso(2025, 1, 1));
    expect(parse("before:today").before).toBe(iso(2026, 9, 16));
    expect(parse("after:yesterday").after).toBe(iso(2026, 9, 15));
  });

  test("older_than and newer_than with relative spans", () => {
    expect(parse("older_than:7d").before).toBe(new Date(2026, 8, 9, 10).toISOString());
    expect(parse("newer_than:2w").after).toBe(new Date(2026, 8, 2, 10).toISOString());
    expect(parse("older_than:3m").before).toBe(new Date(2026, 5, 16, 10).toISOString());
    expect(parse("newer_than:1y").after).toBe(new Date(2025, 8, 16, 10).toISOString());
    expect(parse("newer_than:3").after).toBe(new Date(2026, 8, 13, 10).toISOString());
  });

  test("two bounds on the same side keep the tighter one", () => {
    const q = parse("after:2026-01-01 after:2026-06-01 before:2026-12-01 before:2026-09-01");
    expect(q.after).toBe(iso(2026, 6, 1));
    expect(q.before).toBe(iso(2026, 9, 1));
  });
});

describe("parser: negation", () => {
  test("a leading dash negates words, phrases and every field operator", () => {
    const q = parse(
      '-noreply -"out of office" -from:github -to:ravi -subject:digest -in:finance -tag:x -label:y',
    );
    expect(q.words).toEqual([{ text: "noreply", negated: true }]);
    expect(q.phrases).toEqual([{ text: "out of office", negated: true }]);
    expect(q.from[0]?.negated).toBe(true);
    expect(q.to[0]?.negated).toBe(true);
    expect(q.subject[0]?.negated).toBe(true);
    expect(q.group[0]?.negated).toBe(true);
    expect(q.tags[0]?.negated).toBe(true);
    expect(q.labels[0]?.negated).toBe(true);
    expect(hasBodyTerms(q)).toBe(false);
  });

  test("negated booleans flip", () => {
    expect(parse("-is:unread").unread).toBe(false);
    expect(parse("-is:starred").starred).toBe(false);
    expect(parse("-has:attachment").hasAttachment).toBe(false);
  });

  test("a negated date bound becomes the opposite bound", () => {
    expect(parse("-before:2026-09-01").after).toBe(iso(2026, 9, 1));
    expect(parse("-older_than:7d").after).toBe(new Date(2026, 8, 9, 10).toISOString());
  });

  test("a lone dash and a dash before a space are just text", () => {
    expect(parse("-").words).toEqual([{ text: "-", negated: false }]);
    expect(parse("- rust").words).toEqual([
      { text: "-", negated: false },
      { text: "rust", negated: false },
    ]);
  });
});

describe("parser: malformed input never throws", () => {
  const inputs = [
    "",
    "   ",
    '"',
    '"unterminated phrase',
    "from:",
    "from: kenji",
    "to:",
    "before:",
    "before:notadate",
    "after:2026-13-45",
    "older_than:soon",
    "newer_than:-3d",
    "has:",
    "has:wings",
    "is:",
    "is:purple",
    "in:",
    "tag:",
    "label:",
    "::::",
    "from:from:from:",
    '-"',
    "-from:",
    "\u0000\uffff",
    "a".repeat(10_000),
    'subject:""',
    "unknown:operator",
  ];
  for (const input of inputs) {
    test(JSON.stringify(input.slice(0, 40)), () => {
      const q = parse(input);
      expect(q.raw).toBe(input);
      expect(() => compileQuery(q)).not.toThrow();
    });
  }

  test("an operator with a value the parser rejects becomes a bare word as typed", () => {
    expect(parse("before:notadate").words).toEqual([{ text: "before:notadate", negated: false }]);
    expect(parse("has:wings").words).toEqual([{ text: "has:wings", negated: false }]);
    expect(parse("-is:purple").words).toEqual([{ text: "is:purple", negated: true }]);
    expect(parse("unknown:operator").words).toEqual([{ text: "unknown:operator", negated: false }]);
  });

  test("a dangling operator while typing matches nothing and breaks nothing", () => {
    const q = parse("from:");
    expect(isEmpty(q)).toBe(true);
    expect(compileQuery(q).match).toBeNull();
  });

  test("an empty query is empty", () => {
    expect(isEmpty(parse(""))).toBe(true);
    expect(isEmpty(emptyQuery())).toBe(true);
  });
});

describe("dates", () => {
  test("absolute dates reject impossible calendar days", () => {
    expect(parseAbsoluteDate("2026-02-30", NOW)).toBeNull();
    expect(parseAbsoluteDate("2026-00-01", NOW)).toBeNull();
    expect(parseAbsoluteDate("26-01-01", NOW)).toBeNull();
    expect(parseAbsoluteDate("2026-02-28", NOW)?.getDate()).toBe(28);
  });

  test("relative spans need a number and an optional unit", () => {
    expect(parseRelativeSpan("7", NOW)).not.toBeNull();
    expect(parseRelativeSpan("7D", NOW)).not.toBeNull();
    expect(parseRelativeSpan("d7", NOW)).toBeNull();
    expect(parseRelativeSpan("", NOW)).toBeNull();
  });
});

describe("compiler", () => {
  test("bare words become prefix phrases over every column", () => {
    const c = compileQuery(parse("take-home rust"));
    expect(c.match).toBe(
      '{subject sender recipients body}: "take home" * {subject sender recipients body}: "rust" *',
    );
    expect(c.where).toBe("");
    expect(c.params).toEqual([]);
    expect(c.bodyTerms).toBe(true);
  });

  test("phrases match in order without a prefix", () => {
    const c = compileQuery(parse('"pro-rata clause"'));
    expect(c.match).toBe('{subject sender recipients body}: "pro rata clause"');
  });

  test("field operators bind to their column and addresses become phrases", () => {
    const c = compileQuery(parse("from:kenji.w@meridianfund.co to:ravi subject:term"));
    expect(c.match).toBe(
      'sender: "kenji w meridianfund co" * recipients: "ravi" * subject: "term" *',
    );
    expect(c.bodyTerms).toBe(false);
  });

  test("negated terms compile to exclusions, never into the positive match", () => {
    const c = compileQuery(parse('-from:noreply rust -"out of office"'));
    expect(c.match).toBe('{subject sender recipients body}: "rust" *');
    expect(c.exclude).toEqual([
      '{subject sender recipients body}: "out of office"',
      'sender: "noreply" *',
    ]);
  });

  test("a query of only negations has no positive match", () => {
    const c = compileQuery(parse("-from:noreply"));
    expect(c.match).toBeNull();
    expect(c.exclude).toEqual(['sender: "noreply" *']);
  });

  test("booleans and dates become predicates with bound params", () => {
    const c = compileQuery(
      parse("is:unread -is:starred has:attachment after:2026-09-01 before:2026-09-16"),
    );
    expect(c.match).toBeNull();
    expect(c.where).toBe(
      "t.has_attachments = 1 and t.unread = 1 and t.starred = 0 and t.last_activity < ? and t.last_activity >= ?",
    );
    expect(c.params).toEqual([iso(2026, 9, 16), iso(2026, 9, 1)]);
  });

  test("group, tag and label look up names or ids", () => {
    const c = compileQuery(parse("in:hiring tag:candidate -label:inbox"));
    expect(c.where).toContain("g.id = t.group_id or g.id = t.subgroup_id");
    expect(c.where).toContain("thread_tags tt join tags g");
    expect(c.where).toContain("not exists (select 1 from thread_labels");
    expect(c.params).toEqual([
      "hiring",
      "hiring",
      "candidate",
      "candidate",
      "inbox",
      "inbox",
      "inbox",
    ]);
  });

  test("bare words of three characters or more also go to the trigram index", () => {
    expect(compileQuery(parse("ridianfund ab")).trigram).toBe('"ridianfund"');
    expect(compileQuery(parse("ab")).trigram).toBeNull();
    expect(compileQuery(parse("-ridianfund")).trigram).toBeNull();
    expect(compileQuery(parse("ridianfund from:kenji")).trigram).toBeNull();
    expect(compileQuery(parse('ridianfund "a phrase"')).trigram).toBeNull();
  });

  test("double quotes inside a term are doubled for FTS5", () => {
    const c = compileQuery(parse('say:"hi"'));
    expect(c.match).toBe('{subject sender recipients body}: "say hi" *');
    expect(() => compileQuery(parse('"a""b"'))).not.toThrow();
  });
});

describe("autocomplete", () => {
  const senders = [
    { name: "Kenji Watanabe", email: "kenji.w@meridianfund.co" },
    { name: "Aoife Brennan", email: "aoife@northlight.dev" },
  ];

  test("offers operators that start with the token", () => {
    expect(complete("is", senders).map((c) => c.text)).toEqual([
      "is:unread",
      "is:read",
      "is:starred",
    ]);
    expect(complete("rust fr", senders).map((c) => c.text)).toEqual(["from:"]);
    expect(complete("-fr", senders).map((c) => c.text)).toEqual(["-from:"]);
    expect(complete("", senders)).toEqual([]);
    expect(complete("from:", senders).every((c) => c.kind === "sender")).toBe(true);
  });

  test("offers known senders after from: and to:, matching name or address", () => {
    expect(complete("from:ken", senders)).toEqual([
      {
        text: "from:kenji.w@meridianfund.co",
        kind: "sender",
        label: "Kenji Watanabe <kenji.w@meridianfund.co>",
      },
    ]);
    expect(complete("to:northlight", senders).map((c) => c.text)).toEqual([
      "to:aoife@northlight.dev",
    ]);
    expect(complete("from:", senders).length).toBe(2);
    expect(complete("from:zzz", senders)).toEqual([]);
  });

  test("every operator in the list is parseable", () => {
    for (const op of OPERATORS) expect(() => parse(`${op}x`)).not.toThrow();
  });
});
